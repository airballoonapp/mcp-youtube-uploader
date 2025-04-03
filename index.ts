#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { S3Client, PutObjectCommand, PutObjectCommandInput } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import ytsr from "ytsr";
import youtubeDl from 'youtube-dl-exec';

import fs from "fs";
import path from "path";
import os from "os";


// ============ ENVIRONMENT VARIABLES =============
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION;

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

// 작업 상태 관리를 위한 Map
interface JobStatus {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  urls: string[];
  error?: string;
  startTime: number;
  completedTime?: number;
}

const jobsMap = new Map<string, JobStatus>();

////////////////////////////////////////////////////////////////////////////////
// 1) YouTube Search
////////////////////////////////////////////////////////////////////////////////
const YOUTUBE_SEARCH_TOOL: Tool = {
    name: "youtube_search",
    description:
        "YouTube에서 키워드로 비디오를 검색합니다. 최대 maxResults 개수만큼의 YouTube 비디오 URL 목록을 반환합니다. " +
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

async function youtubeSearchHandler(args: any) {
    const { query, maxResults = 10 } = args;
    if (!query) {
        throw new Error("No query provided for YouTube search");
    }

    // Perform search using ytsr
    const searchResults = await ytsr(query, { limit: maxResults });
    const finalUrls: string[] = [];

    searchResults.items.forEach((item: any) => {
        if (item.type === "video" && item.url) {
            finalUrls.push(item.url);
        }
    });

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

////////////////////////////////////////////////////////////////////////////////
// 2) YouTube Download + S3 Upload (비동기 처리)
////////////////////////////////////////////////////////////////////////////////
const UPLOAD_VIDEOS_S3_TOOL: Tool = {
    name: "upload_videos_s3",
    description:
        "YouTube 비디오 URL 목록을 받아 로컬에 mp4로 다운로드한 후 S3에 업로드하고 공개 액세스 가능한 상태로 만들어 작업 ID를 반환합니다. " +
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
const CHECK_UPLOAD_JOB_STATUS_TOOL: Tool = {
    name: "check_upload_job_status",
    description:
        "비동기 비디오 업로드 작업의 상태를 확인합니다. 작업 상태와 업로드된 비디오의 공개 S3 URL을 반환합니다. " +
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
const GET_JOB_URLS_TOOL: Tool = {
    name: "get_job_urls",
    description:
        "완료된 업로드 작업에서 공개 S3 URL 목록만 반환합니다. 작업이 아직 완료되지 않은 경우 빈 목록을 반환합니다. " +
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

async function uploadVideosS3Handler(args: any) {
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

async function checkUploadJobStatusHandler(args: any) {
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
                    processingTimeMs: job.completedTime ? (job.completedTime - job.startTime) : (Date.now() - job.startTime)
                }, null, 2),
            },
        ],
        isError: false,
    };
}

async function getJobUrlsHandler(args: any) {
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

// 비동기 처리 함수
async function processVideosAsync(jobId: string, videoUrls: string[], bucket: string) {
    const job = jobsMap.get(jobId);
    if (!job) return;
    
    job.status = 'processing';
    jobsMap.set(jobId, job);
    
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));
    const publicUrls: string[] = [];
    
    try {
        for (const url of videoUrls) {
            try {
                // 유튜브 동영상 url 검증
                if (!url.includes('youtube.com/watch') && !url.includes('youtu.be/')) {
                    throw new Error(`Invalid YouTube URL: ${url}`);
                }

                // 1) 동영상 정보 가져오기
                const videoInfo = await youtubeDl.exec(url, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    preferFreeFormats: true,
                    youtubeSkipDashManifest: true
                });
                
                // 파일명 생성
                const info = JSON.parse(videoInfo.stdout);
                const baseTitle = info.title.replace(/[^\w\s.-]+/g, "_");
                const fileName = `${baseTitle}_${uuidv4()}.mp4`;
                const localPath = path.join(tempDir, fileName);
                
                // 2) 동영상 다운로드
                await youtubeDl.exec(url, {
                    output: localPath,
                    format: 'best[ext=mp4]/best',
                    noWarnings: true,
                    preferFreeFormats: true
                });
                
                // 3) S3에 업로드 - 생성되는 URL은 TwelveLabs의 upload_videos에 직접 사용 가능합니다
                const putParams: any = {
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
                
                // 작업 상태 업데이트
                const currentJob = jobsMap.get(jobId);
                if (currentJob) {
                    currentJob.urls.push(publicUrl);
                    jobsMap.set(jobId, currentJob);
                }
            } catch (err: any) {
                console.warn(`[job ${jobId}] Error processing ${url}: ${err}`);
            }
        }
        
        // 작업 완료 설정
        const finalJob = jobsMap.get(jobId);
        if (finalJob) {
            finalJob.status = 'completed';
            finalJob.completedTime = Date.now();
            jobsMap.set(jobId, finalJob);
        }
    } catch (err: any) {
        const failedJob = jobsMap.get(jobId);
        if (failedJob) {
            failedJob.status = 'failed';
            failedJob.error = err.message || '알 수 없는 오류';
            failedJob.completedTime = Date.now();
            jobsMap.set(failedJob.id, failedJob);
        }
        throw err;
    } finally {
        // 임시 디렉토리 삭제 (비동기 처리)
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
            console.warn(`Failed to clean up temp directory: ${tempDir}`);
        }
    }
    
    return publicUrls;
}

////////////////////////////////////////////////////////////////////////////////
// SETTING UP THE MCP SERVER
////////////////////////////////////////////////////////////////////////////////

const server = new Server(
    {
        name: "my-youtube-mcp",
        version: "0.1.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Return the list of tools we provide
    return {
        tools: [
            YOUTUBE_SEARCH_TOOL,
            UPLOAD_VIDEOS_S3_TOOL,
            CHECK_UPLOAD_JOB_STATUS_TOOL,
            GET_JOB_URLS_TOOL
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
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
