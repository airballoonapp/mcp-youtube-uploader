#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import ytsr from "ytsr";
import youtubeDl from 'youtube-dl-exec';
import fs from "fs";
import path from "path";
import os from "os";
// ============ ENVIRONMENT VARIABLES =============
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || 'youtube-video-000';
const AWS_REGION = process.env.AWS_REGION || 'us-west-2'; // 기본 리전 설정
// Basic validation:
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_S3_BUCKET_NAME) {
    console.error("Missing AWS credentials or bucket name in environment variables.");
}
const s3 = new S3Client({
    region: AWS_REGION,
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: false,
});
const jobsMap = new Map();
////////////////////////////////////////////////////////////////////////////////
// 1) YouTube Search
////////////////////////////////////////////////////////////////////////////////
const YOUTUBE_SEARCH_TOOL = {
    name: "youtube_search",
    description: "YouTube에서 키워드로 비디오를 검색합니다. 최대 maxResults 개수만큼의 YouTube 비디오 URL 목록을 반환합니다. " +
        "이 URL은 직접적인 비디오 파일 URL이 아닌 YouTube 웹사이트 URL(예: https://youtube.com/watch?v=xxxx)입니다. " +
        "이 YouTube URL은 TwelveLabs의 video_upload 도구에 직접 사용할 수 없으며, upload_videos_s3 도구를 통해 S3로 업로드한 후 얻은 URL을 사용해야 합니다.",
    inputSchema: {
        type: "object",
        properties: {
            query: { type: "string", description: "검색할 키워드" },
            maxResults: { type: "number", description: "반환할 최대 결과 수", default: 10 },
        },
        required: ["query"],
    },
};
async function youtubeSearchHandler(args) {
    const { query, maxResults = 10 } = args;
    if (!query) {
        throw new Error("No query provided for YouTube search");
    }
    try {
        // Perform search using ytsr
        const searchResults = await ytsr(query, { limit: maxResults });
        const finalUrls = [];
        // YouTube 검색 결과에서 비디오 URL만 필터링
        if (searchResults && searchResults.items) {
            searchResults.items.forEach((item) => {
                if (item.type === "video" && item.url) {
                    finalUrls.push(item.url);
                }
            });
        }
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(finalUrls, null, 2),
                },
            ],
            isError: false,
        };
    }
    catch (err) {
        console.error("YouTube 검색 오류:", err.message);
        // 에러 발생 시 빈 배열 반환하거나 YouTube URL 예시 제공
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: `YouTube 검색 중 오류가 발생했습니다: ${err.message}`,
                        message: "ytsr 라이브러리 에러로 인해 직접 YouTube URL을 입력해주세요."
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
}
////////////////////////////////////////////////////////////////////////////////
// 2) YouTube Download + S3 Upload (비동기 처리)
////////////////////////////////////////////////////////////////////////////////
const UPLOAD_VIDEOS_S3_TOOL = {
    name: "upload_videos_s3",
    description: "YouTube 비디오 URL 목록을 받아 로컬에 mp4로 다운로드한 후 S3에 업로드하고 공개 액세스 가능한 상태로 만들어 작업 ID를 반환합니다. " +
        "이 작업은 비동기적으로 처리되며, 상태는 check_upload_job_status 도구로 확인할 수 있습니다. " +
        "완료 후 반환되는 S3 URL(https://<bucket>.s3.<region>.amazonaws.com/<filename>.mp4 형식)은 " +
        "TwelveLabs의 upload_videos 도구에 직접 사용할 수 있는 raw 비디오 파일 URL입니다.",
    inputSchema: {
        type: "object",
        properties: {
            videoUrls: {
                type: "array",
                items: { type: "string" },
                description: "YouTube 비디오 URL 배열 (https://youtube.com/watch?v=xxxx 또는 https://youtu.be/xxxx 형식)"
            },
            bucketName: {
                type: "string",
                description: "기본 S3 버킷 이름 대신 사용할 버킷 이름 (선택사항)",
            },
        },
        required: ["videoUrls"],
    },
};
// 작업 상태 확인 도구
const CHECK_UPLOAD_JOB_STATUS_TOOL = {
    name: "check_upload_job_status",
    description: "비동기 비디오 업로드 작업의 상태를 확인합니다. 작업 상태와 업로드된 비디오의 공개 S3 URL을 반환합니다. " +
        "또한 현재 진행률(처리된 비디오 수, 전체 비디오 수, 백분율)과 예상 남은 시간(밀리초 및 읽기 쉬운 형식)도 제공합니다. " +
        "완료된 작업의 경우 반환되는 S3 URL(https://<bucket>.s3.<region>.amazonaws.com/<filename>.mp4 형식)은 " +
        "TwelveLabs의 upload_videos 도구에 직접 입력할 수 있는 raw 비디오 파일 URL입니다.",
    inputSchema: {
        type: "object",
        properties: {
            jobId: {
                type: "string",
                description: "upload_videos_s3 도구에서 반환된 작업 ID"
            }
        },
        required: ["jobId"],
    },
};
// 완료된 작업의 URL만 반환하는 도구
const GET_JOB_URLS_TOOL = {
    name: "get_job_urls",
    description: "완료된 업로드 작업에서 공개 S3 URL 목록만 반환합니다. 작업이 아직 완료되지 않은 경우 빈 목록을 반환합니다. " +
        "반환되는 S3 URL(https://<bucket>.s3.<region>.amazonaws.com/<filename>.mp4 형식)은 " +
        "TwelveLabs의 upload_videos 도구에 직접 사용할 수 있는 raw 비디오 파일 URL입니다. " +
        "이 S3 URL은 TwelveLabs에서 비디오 인덱싱 및 분석을 위해 사용됩니다.",
    inputSchema: {
        type: "object",
        properties: {
            jobId: {
                type: "string",
                description: "upload_videos_s3 도구에서 반환된 작업 ID"
            }
        },
        required: ["jobId"],
    },
};
////////////////////////////////////////////////////////////////////////////////
// S3 비디오 리스트 가져오기
////////////////////////////////////////////////////////////////////////////////
const LIST_S3_VIDEOS_TOOL = {
    name: "list_s3_videos",
    description: "S3 버킷에 저장된 모든 비디오 파일의 목록을 가져옵니다. 이 도구는 S3 버킷에 이미 업로드된 비디오를 확인하여 중복 업로드를 방지하는데 사용할 수 있습니다. " +
        "각 비디오의 키(파일 이름)와 공개 URL(https://<bucket>.s3.<region>.amazonaws.com/<filename> 형식)을 반환합니다.",
    inputSchema: {
        type: "object",
        properties: {
            bucketName: {
                type: "string",
                description: "기본 S3 버킷 이름 대신 사용할 버킷 이름 (선택사항)",
            },
            prefix: {
                type: "string",
                description: "특정 접두사(폴더)에 있는 파일만 필터링 (선택사항)",
            }
        },
        required: [],
    },
};
// 유튜브 URL에서 동영상 ID를 추출하는 함수
function extractYoutubeId(url) {
    let regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    let match = url.match(regExp);
    if (match && match[2].length === 11) {
        return match[2];
    }
    return null;
}
async function uploadVideosS3Handler(args) {
    const { videoUrls, bucketName } = args;
    if (!Array.isArray(videoUrls) || videoUrls.length === 0) {
        throw new Error("videoUrls must be a non-empty array of YouTube URLs");
    }
    const bucket = bucketName || AWS_S3_BUCKET_NAME;
    if (!bucket) {
        throw new Error("No S3 bucket name configured or provided");
    }
    // 작업 ID 생성
    const jobId = uuidv4();
    // 작업 상태 초기화
    jobsMap.set(jobId, {
        id: jobId,
        status: 'pending',
        urls: [],
        startTime: Date.now()
    });
    // 비동기로 처리 시작
    processVideosAsync(jobId, videoUrls, bucket).catch(err => {
        console.error(`Job ${jobId} failed:`, err);
        const job = jobsMap.get(jobId);
        if (job) {
            job.status = 'failed';
            job.error = err.message || '알 수 없는 오류';
            job.completedTime = Date.now();
            jobsMap.set(jobId, job);
        }
    });
    // 즉시 작업 ID 반환
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ jobId }, null, 2),
            },
        ],
        isError: false,
    };
}
async function checkUploadJobStatusHandler(args) {
    const { jobId } = args;
    if (!jobId || typeof jobId !== 'string') {
        throw new Error("Valid jobId is required");
    }
    const job = jobsMap.get(jobId);
    if (!job) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: "Job not found" }, null, 2),
                },
            ],
            isError: true,
        };
    }
    // 남은 시간을 사람이 읽기 쉬운 형식으로 변환
    let readableTimeRemaining = null;
    if (job.estimatedTimeRemaining !== undefined && job.estimatedTimeRemaining > 0) {
        const seconds = Math.floor(job.estimatedTimeRemaining / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes > 0) {
            readableTimeRemaining = `약 ${minutes}분 ${remainingSeconds}초`;
        }
        else {
            readableTimeRemaining = `약 ${seconds}초`;
        }
    }
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    jobId: job.id,
                    status: job.status,
                    urls: job.urls,
                    error: job.error,
                    startTime: new Date(job.startTime).toISOString(),
                    completedTime: job.completedTime ? new Date(job.completedTime).toISOString() : undefined,
                    processingTimeMs: job.completedTime ? (job.completedTime - job.startTime) : (Date.now() - job.startTime),
                    progress: job.progress,
                    estimatedTimeRemaining: job.estimatedTimeRemaining,
                    readableTimeRemaining: readableTimeRemaining
                }, null, 2),
            },
        ],
        isError: false,
    };
}
async function getJobUrlsHandler(args) {
    const { jobId } = args;
    if (!jobId || typeof jobId !== 'string') {
        throw new Error("Valid jobId is required");
    }
    const job = jobsMap.get(jobId);
    if (!job) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: "Job not found" }, null, 2),
                },
            ],
            isError: true,
        };
    }
    // 작업이 완료되었을 때만 URL 반환, 그렇지 않으면 빈 배열 반환
    const urls = (job.status === 'completed') ? job.urls : [];
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(urls, null, 2),
            },
        ],
        isError: false,
    };
}
async function listS3VideosHandler(args) {
    const { bucketName, prefix } = args;
    const bucket = bucketName || AWS_S3_BUCKET_NAME;
    if (!bucket) {
        throw new Error("No S3 bucket name configured or provided");
    }
    try {
        // AWS 리전 값 확인
        if (!AWS_REGION) {
            throw new Error("AWS_REGION is not defined. Please set the AWS_REGION environment variable.");
        }
        // S3 버킷의 모든 객체 리스트 가져오기
        const listParams = {
            Bucket: bucket,
            Prefix: prefix || ''
        };
        const command = new ListObjectsV2Command(listParams);
        const data = await s3.send(command);
        if (!data.Contents) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ files: [] }, null, 2),
                    },
                ],
                isError: false,
            };
        }
        // 결과 처리
        const videoFiles = data.Contents.map(item => {
            return {
                key: item.Key,
                url: `https://${bucket}.s3.${AWS_REGION}.amazonaws.com/${item.Key}`,
                size: item.Size,
                lastModified: item.LastModified
            };
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ files: videoFiles }, null, 2),
                },
            ],
            isError: false,
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: `S3 버킷에서 비디오 목록을 가져오는 중 오류가 발생했습니다: ${err.message}`
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
}
// 수정된 비동기 처리 함수
async function processVideosAsync(jobId, videoUrls, bucket) {
    const job = jobsMap.get(jobId);
    if (!job)
        return;
    job.status = 'processing';
    job.progress = {
        current: 0,
        total: videoUrls.length,
        percentage: 0
    };
    jobsMap.set(jobId, job);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));
    const publicUrls = [];
    // 진행률 추적을 위한 시작 시간과 처리된 동영상 당 평균 처리 시간
    const processingStartTime = Date.now();
    let totalProcessingTime = 0;
    let successCount = 0;
    // S3에 이미 존재하는 파일 목록 가져오기
    let existingFiles = [];
    try {
        const listParams = {
            Bucket: bucket
        };
        const command = new ListObjectsV2Command(listParams);
        const data = await s3.send(command);
        if (data.Contents) {
            existingFiles = data.Contents.map(item => item.Key || '');
        }
    }
    catch (err) {
        console.warn(`[job ${jobId}] Failed to fetch existing files from S3: ${err}`);
    }
    try {
        for (let i = 0; i < videoUrls.length; i++) {
            const url = videoUrls[i];
            const videoStartTime = Date.now();
            try {
                // 유튜브 동영상 url 검증
                if (!url.includes('youtube.com/watch') && !url.includes('youtu.be/')) {
                    throw new Error(`Invalid YouTube URL: ${url}`);
                }
                // YouTube ID 추출
                const videoId = extractYoutubeId(url);
                if (!videoId) {
                    throw new Error(`Could not extract YouTube ID from URL: ${url}`);
                }
                // 1) 동영상 정보 가져오기
                const videoInfo = await youtubeDl.exec(url, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    preferFreeFormats: true,
                    youtubeSkipDashManifest: true
                });
                // YouTube ID를 포함한 파일명 생성
                const info = JSON.parse(videoInfo.stdout);
                const fileName = `youtube_${videoId}.mp4`;
                const localPath = path.join(tempDir, fileName);
                // 이미 S3에 같은 이름의 파일이 있는지 확인
                const fileExists = existingFiles.some(key => key === fileName);
                if (fileExists) {
                    console.error(`[job ${jobId}] Video already exists in S3, skipping: ${url} (ID: ${videoId})`);
                    // 이미 존재하는 파일의 URL을 결과에 추가
                    const existingUrl = `https://${bucket}.s3.${AWS_REGION}.amazonaws.com/${fileName}`;
                    publicUrls.push(existingUrl);
                    // 작업 상태 업데이트
                    const currentJob = jobsMap.get(jobId);
                    if (currentJob) {
                        // 동영상 URL 추가
                        currentJob.urls.push(existingUrl);
                        // 진행률 업데이트
                        currentJob.progress = {
                            current: i + 1,
                            total: videoUrls.length,
                            percentage: Math.round(((i + 1) / videoUrls.length) * 100)
                        };
                        // 남은 시간 추정 (이미 존재하는 파일은 빠르게 처리되므로 평균 시간 계산에는 포함하지 않음)
                        if (i > 0) {
                            const remainingVideos = videoUrls.length - (i + 1);
                            const avgTimePerVideo = successCount > 0 ? totalProcessingTime / successCount : totalProcessingTime;
                            currentJob.estimatedTimeRemaining = avgTimePerVideo * remainingVideos;
                        }
                        jobsMap.set(jobId, currentJob);
                    }
                    continue;
                }
                // 2) 동영상 다운로드
                await youtubeDl.exec(url, {
                    output: localPath,
                    format: 'best[ext=mp4]/best',
                    noWarnings: true,
                    preferFreeFormats: true
                });
                // AWS 리전 값 확인
                if (!AWS_REGION) {
                    throw new Error("AWS_REGION is not defined. Please set the AWS_REGION environment variable.");
                }
                // 3) S3에 업로드 - 생성되는 URL은 TwelveLabs의 upload_videos에 직접 사용 가능합니다
                const putParams = {
                    Bucket: bucket,
                    Key: fileName,
                    Body: fs.createReadStream(localPath),
                    ACL: "public-read", // Make public
                    ContentType: "video/mp4",
                };
                await s3.send(new PutObjectCommand(putParams));
                // 공개 URL - TwelveLabs의 upload_videos 도구에 직접 사용 가능한 형식입니다
                const publicUrl = `https://${bucket}.s3.${AWS_REGION}.amazonaws.com/${fileName}`;
                publicUrls.push(publicUrl);
                // 성공적으로 처리된 비디오 수 증가
                successCount++;
                // S3 파일 목록에 추가 (다음 반복에서 중복 체크를 위해)
                existingFiles.push(fileName);
                // 작업 상태 업데이트
                const currentJob = jobsMap.get(jobId);
                if (currentJob) {
                    // 동영상 URL 추가
                    currentJob.urls.push(publicUrl);
                    // 진행률 업데이트
                    const videoProcessingTime = Date.now() - videoStartTime;
                    totalProcessingTime += videoProcessingTime;
                    currentJob.progress = {
                        current: i + 1,
                        total: videoUrls.length,
                        percentage: Math.round(((i + 1) / videoUrls.length) * 100)
                    };
                    // 남은 시간 추정
                    if (i > 0) {
                        const avgTimePerVideo = successCount > 0 ? totalProcessingTime / successCount : totalProcessingTime;
                        const remainingVideos = videoUrls.length - (i + 1);
                        currentJob.estimatedTimeRemaining = avgTimePerVideo * remainingVideos;
                    }
                    jobsMap.set(jobId, currentJob);
                }
            }
            catch (err) {
                console.warn(`[job ${jobId}] Error processing ${url}: ${err.message}`);
                // 상태 업데이트 (에러가 발생해도 진행 상황은 업데이트)
                const currentJob = jobsMap.get(jobId);
                if (currentJob) {
                    currentJob.progress = {
                        current: i + 1,
                        total: videoUrls.length,
                        percentage: Math.round(((i + 1) / videoUrls.length) * 100)
                    };
                    if (i > 0) {
                        const avgTimePerVideo = successCount > 0 ? totalProcessingTime / successCount : totalProcessingTime / Math.max(1, i);
                        const remainingVideos = videoUrls.length - (i + 1);
                        currentJob.estimatedTimeRemaining = avgTimePerVideo * remainingVideos;
                    }
                    jobsMap.set(jobId, currentJob);
                }
            }
        }
        // 작업 완료 설정
        const finalJob = jobsMap.get(jobId);
        if (finalJob) {
            finalJob.status = 'completed';
            finalJob.progress = {
                current: videoUrls.length,
                total: videoUrls.length,
                percentage: 100
            };
            finalJob.estimatedTimeRemaining = 0;
            finalJob.completedTime = Date.now();
            jobsMap.set(jobId, finalJob);
        }
    }
    catch (err) {
        const failedJob = jobsMap.get(jobId);
        if (failedJob) {
            failedJob.status = 'failed';
            failedJob.error = err.message || '알 수 없는 오류';
            failedJob.completedTime = Date.now();
            jobsMap.set(failedJob.id, failedJob);
        }
        throw err;
    }
    finally {
        // 임시 디렉토리 삭제 (비동기 처리)
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch (e) {
            console.warn(`Failed to clean up temp directory: ${tempDir}`);
        }
    }
    return publicUrls;
}
////////////////////////////////////////////////////////////////////////////////
// SETTING UP THE MCP SERVER
////////////////////////////////////////////////////////////////////////////////
const server = new Server({
    name: "my-youtube-mcp",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Return the list of tools we provide
    return {
        tools: [
            YOUTUBE_SEARCH_TOOL,
            UPLOAD_VIDEOS_S3_TOOL,
            CHECK_UPLOAD_JOB_STATUS_TOOL,
            GET_JOB_URLS_TOOL,
            LIST_S3_VIDEOS_TOOL
        ],
    };
});
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params;
    switch (name) {
        case "youtube_search":
            return youtubeSearchHandler(toolArgs);
        case "upload_videos_s3":
            return uploadVideosS3Handler(toolArgs);
        case "check_upload_job_status":
            return checkUploadJobStatusHandler(toolArgs);
        case "get_job_urls":
            return getJobUrlsHandler(toolArgs);
        case "list_s3_videos":
            return listS3VideosHandler(toolArgs);
        default:
            return {
                content: [
                    { type: "text", text: `Unknown tool requested: ${name}` },
                ],
                isError: true,
            };
    }
});
////////////////////////////////////////////////////////////////////////////////
// STARTING (via stdio)
////////////////////////////////////////////////////////////////////////////////
(async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("YouTube MCP Server started. Listening on stdio...");
})().catch((err) => {
    console.error("Fatal error in server:", err);
    process.exit(1);
});
