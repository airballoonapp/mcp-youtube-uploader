# My YouTube MCP Server

An [MCP](https://modelcontextprotocol.io/) server that supports:

1. **YouTube Searching** (`youtube_search`)
2. **Downloading & Uploading Videos to S3** (`upload_videos_s3`)
3. **Optional** Import into [TwelveLabs](https://twelvelabs.io) (`import_videos_twelvelabs`)

## Installation

```bash
# 1) Install dependencies
npm install

# 2) Build
npm run build

# 3) Run locally
npm start

```

## 환경 설정

다음 환경 변수를 설정합니다:

```
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_S3_BUCKET_NAME=youtube-video-000 (or your bucket name)
AWS_REGION=us-west-2 (or your region)
YOUTUBE_API_KEY=your_youtube_api_key
```

YouTube API 키는 [Google Cloud Console](https://console.cloud.google.com/)에서 YouTube Data API v3에 대한 API 키를 생성하여 얻을 수 있습니다.

## 기능 설명

### YouTube 비디오 정보 가져오기

YouTube 비디오 정보를 가져올 때 이제 다음과 같은 우선순위로 시도합니다:

1. **YouTube Data API v3** (YOUTUBE_API_KEY 환경 변수 필요)
2. **youtube-dl-exec** (fallback)
3. **ytdl-core** (secondary fallback)

YouTube Data API를 사용하면 더 안정적이고 정확한 정보를 얻을 수 있으며, API 할당량 제한 내에서 사용해야 합니다.
