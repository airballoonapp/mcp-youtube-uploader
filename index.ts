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
        "Search YouTube for videos matching a query. Returns a list of up to maxResults YouTube video URLs. " +
        "Ideal for discovering relevant video content by keyword.",
    inputSchema: {
        type: "object",
        properties: {
            query: { type: "string", description: "The search keyword(s)" },
            maxResults: { type: "number", description: "Max number of results to return", default: 10 },
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
        "Given a list of YouTube video URLs, downloads them locally as mp4, then uploads them to S3, makes them public, and returns a job ID. " +
        "The job is processed asynchronously, and you can check its status with check_upload_job_status.",
    inputSchema: {
        type: "object",
        properties: {
            videoUrls: {
                type: "array",
                items: { type: "string" },
                description: "Array of YouTube video URLs"
            },
            bucketName: {
                type: "string",
                description: "Override the default S3 bucket name",
            },
        },
        required: ["videoUrls"],
    },
};

// 작업 상태 확인 도구
const CHECK_UPLOAD_JOB_STATUS_TOOL: Tool = {
    name: "check_upload_job_status",
    description:
        "Check the status of an asynchronous video upload job. Returns the job status and public URLs of uploaded videos if completed.",
    inputSchema: {
        type: "object",
        properties: {
            jobId: {
                type: "string",
                description: "Job ID returned from the upload_videos_s3 tool"
            }
        },
        required: ["jobId"],
    },
};

// 완료된 작업의 URL만 반환하는 도구
const GET_JOB_URLS_TOOL: Tool = {
    name: "get_job_urls",
    description:
        "Get only the list of public URLs from a completed upload job. If the job is not completed yet, returns an empty list.",
    inputSchema: {
        type: "object",
        properties: {
            jobId: {
                type: "string", 
                description: "Job ID returned from the upload_videos_s3 tool"
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
                
                // 3) S3에 업로드
                const putParams: any = {
                    Bucket: bucket,
                    Key: fileName,
                    Body: fs.createReadStream(localPath),
                    ACL: "public-read", // Make public
                    ContentType: "video/mp4",
                };
                await s3.send(new PutObjectCommand(putParams));

                // 공개 URL
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
