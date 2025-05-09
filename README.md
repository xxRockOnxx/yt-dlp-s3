# yt-dlp-s3

This script downloads videos using `yt-dlp` and uploads them directly to an S3-compatible storage bucket.

No temporary files, straight piping!

## Features

- Download videos from a given URL (supports only playlists currently).
- Stream videos directly to an S3-compatible storage bucket.
- Check if a video (based on its title) already exists in the S3 bucket to avoid re-processing.
- Option to re-upload if the existing file in the bucket has a different size.
- Display progress for downloads and uploads.
- Graceful shutdown on `SIGINT` (Ctrl+C), allowing the current video to finish processing.
- Configurable `yt-dlp` executable path.
- Configurable S3 endpoint, credentials, and bucket details.
- Option to create the S3 bucket if it doesn't exist.

## Prerequisites

- `yt-dlp` installed and accessible in your system's PATH, or path specified via `--ytdlp-path`.
- Access to an S3-compatible storage service.

## Installation

1.  Clone the repository or download the script.
2.  Install dependencies:
    ```bash
    bun install
    ```

## Usage

The script is controlled via command-line arguments:

```bash
node index.mjs \
  --url <VIDEO_OR_PLAYLIST_URL> \
  --bucket <S3_BUCKET_NAME> \
  --access-key <S3_ACCESS_KEY> \
  --secret-key <S3_SECRET_KEY> \
  --endpoint <S3_ENDPOINT_URL> \
  [OPTIONS]
```

### Options:

- `-u, --url <url>`: **Required.** Video or playlist URL to download.
- `-b, --bucket <bucket>`: **Required.** S3 bucket name.
- `--access-key <accessKey>`: **Required.** S3 access key. Can also be set via the `S3_ACCESS_KEY` environment variable.
- `--secret-key <secretKey>`: **Required.** S3 secret key. Can also be set via the `S3_SECRET_KEY` environment variable.
- `--endpoint <endpoint>`: **Required.** S3 endpoint URL (e.g., `s3.amazonaws.com` or `your.minio.server:9000`).
- `--ssl`: Enable SSL for S3 connection. (Defaults to `true`)
- `--create-bucket`: Create the S3 bucket if it does not exist. (Defaults to `false`)
- `--reupload-on-size-diff`: Re-upload the file if it already exists in the bucket but has a different size. (Defaults to `false`)
- `--ytdlp-path <path>`: Path to the `yt-dlp` executable. (Defaults to `yt-dlp`, assuming it's in your PATH)
- `--ytdlp-format <format>`: Passed directly to `yt-dlp`'s `-f` option. (Defaults to `bestvideo*+bestaudio/best`)

### Environment Variables

You can set your S3 credentials using environment variables instead of passing them as command-line options:

- `S3_ACCESS_KEY`: Your S3 access key.
- `S3_SECRET_KEY`: Your S3 secret key.

### Example

```bash
node index.mjs \
  --url "https://www.youtube.com/playlist?list=YOUR_PLAYLIST_ID" \
  --bucket "my-video-archive" \
  --access-key "YOUR_ACCESS_KEY" \
  --secret-key "YOUR_SECRET_KEY" \
  --endpoint "s3.customprovider.com" \
  --create-bucket
```

Or using environment variables for credentials:

```bash
export S3_ACCESS_KEY="YOUR_ACCESS_KEY"
export S3_SECRET_KEY="YOUR_SECRET_KEY"

node index.mjs \
  --url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --bucket "my-video-archive" \
  --endpoint "minio.example.com:9000"
```

## Notes

- The script uses the video title and ID as the base for the S3 object key. The final object key will be `%(title)s [%(id)s].%(ext)s`.
- If a video with the exact S3 object key is found in the bucket, it will be skipped unless the `--reupload-on-size-diff` option is enabled and the file sizes differ, in which case it will be re-uploaded.
- Error handling is in place for `yt-dlp` execution and S3 operations. If `yt-dlp` fails or an S3 upload error occurs, the script will exit with an error code.
- On graceful shutdown (Ctrl+C), the script will wait for the currently processing video to complete before exiting. Pressing Ctrl+C again will force immediate exit.
