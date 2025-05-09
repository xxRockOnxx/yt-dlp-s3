import { spawn } from 'node:child_process'
import process from 'node:process'
import * as commander from 'commander'
import mime from 'mime'
import * as Minio from 'minio'
import ora, { oraPromise } from 'ora'
import prettyBytes from 'pretty-bytes'
import which from 'which'

let isShuttingDown = false

process.on('SIGINT', async () => {
  if (isShuttingDown) {
    process.exit(1)
  }
  console.log('Graceful shutdown initiated. Waiting for the current video to finish...')
  isShuttingDown = true
})

async function getBucketObjectKeys(minioClient, bucketName) {
  const spinner = ora('Fetching existing objects in bucket').start()
  const objectMap = new Map()
  const stream = minioClient.listObjectsV2(bucketName, '', true)

  for await (const obj of stream) {
    objectMap.set(obj.name, { size: obj.size })
  }

  spinner.succeed()
  ora(`Found ${objectMap.size} existing objects in bucket`).info()

  return objectMap
}

async function getPlaylistUrls(ytdlpPath, url) {
  const spinner = ora(`Fetching playlist URLs from: ${url}`).start()
  try {
    const output = await executeCommand(ytdlpPath, [
      '--flat-playlist',
      '--restrict-filenames',
      '--print',
      'url',
      '--print',
      'title',
      '--print',
      'filename',

      // Default format but without the extension.
      // The extension will be determined later
      // upon fetching metadata for the video.
      '-o',
      '%(title)s [%(id)s]',
      url,
    ])
    const lines = output.trim().split('\n')
    const urls = []

    // This assumes the output is in the expected format
    // Each video has 3 lines of output
    for (let i = 0; i < lines.length; i += 3) {
      const videoUrl = lines[i]
      const title = lines[i + 1]
      const filename = lines[i + 2]
      urls.push({ videoUrl, title, filename })
    }

    spinner.succeed()
    ora(`Found ${urls.length} video(s) in the playlist`).info()

    return urls
  }
  catch (e) {
    spinner.fail()
    throw e
  }
}

async function getMetadata(ytdlpPath, format, url) {
  const spinner = ora('Fetching metadata (file size and extension)').start()
  try {
    const output = await executeCommand(ytdlpPath, [
      // When yt-dlp is used to stream, the default format is the following.
      '-f',
      format,
      '-O',
      '%(ext)s,%(filesize,filesize_approx)s',
      url,
    ])
    const [ext, filesizeStr] = output.trim().split(',')
    const filesize = Number.parseInt(filesizeStr, 10)
    spinner.succeed()
    return {
      extension: ext.trim(),
      filesize: Number.isNaN(filesize) || filesize < 0 ? 0 : filesize,
    }
  }
  catch (error) {
    spinner.fail()
    throw error
  }
}

async function executeCommand(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args)
    let output = ''
    let error = ''

    process.stdout.on('data', data => output += data)
    process.stderr.on('data', data => error += data)

    process.on('close', (code) => {
      if (code === 0)
        resolve(output)
      else reject(new Error(`Command failed (${code}): ${error}`))
    })
  })
}

async function validateYtDlpPath(ytdlpPath) {
  const spinner = ora('Validating yt-dlp path').start()
  try {
    const path = await which(ytdlpPath)
    spinner.succeed()
    ora(`yt-dlp found at: ${path}`).info()
    return path
  }
  catch (err) {
    spinner.fail(`yt-dlp not found at '${ytdlpPath}' or in PATH`)
    throw err
  }
}

async function initializeMinioClient(options) {
  const minioClient = new Minio.Client({
    endPoint: options.endpoint,
    useSSL: options.ssl,
    accessKey: options.accessKey,
    secretKey: options.secretKey,
  })

  const spinner = ora(`Checking if bucket exists: ${options.bucket}`).start()
  const bucketExists = await minioClient.bucketExists(options.bucket)

  if (!bucketExists && options.createBucket) {
    await oraPromise(() => minioClient.makeBucket(options.bucket), {
      text: `Creating bucket: ${options.bucket}`,
    })
  }
  else if (!bucketExists) {
    spinner.fail('Bucket does not exist and --create-bucket option is not set.')
    throw new Error('Bucket does not exist and --create-bucket option is not set.')
  }

  spinner.succeed()

  return minioClient
}

async function main() {
  const program = new commander.Command()

  program
    .requiredOption('-u, --url <url>', 'Video URL to download')
    .requiredOption('-b, --bucket <bucket>', 'S3 bucket name')
    .requiredOption('--access-key <accessKey>', 'S3 access key', process.env.S3_ACCESS_KEY)
    .requiredOption('--secret-key <secretKey>', 'S3 secret key', process.env.S3_SECRET_KEY)
    .requiredOption('--endpoint <endpoint>', 'S3 endpoint URL')
    .option('--ssl', 'Enable SSL for S3 connection', true)
    .option('--create-bucket', 'Create bucket if it does not exist', false)
    .option('--reupload-on-size-diff', 'Reupload file if the size differs from the one in the bucket', false)
    .option('--ytdlp-path <path>', 'Path to yt-dlp executable', 'yt-dlp')
    .option('--ytdlp-format <format>', 'Format to use for yt-dlp', 'bestvideo*+bestaudio/best')
    .option('--check-full-key', 'Enable exact filename checking (filename.extension). Default is prefix-only checking (filename), which skips metadata fetch if a prefix match is found in S3.', false)
    .parse(process.argv)

  const options = program.opts()
  const ytdlpPath = await validateYtDlpPath(options.ytdlpPath)
  const minioClient = await initializeMinioClient(options)
  const bucketObjectKeys = await getBucketObjectKeys(minioClient, options.bucket)
  const urls = await getPlaylistUrls(ytdlpPath, options.url)

  if (urls.length === 0) {
    process.exit(0)
  }

  ora(options.checkFullKey ? 'Exact filename checking enabled' : 'Prefix-only checking enabled').info()
  console.log()

  for (let i = 0; i < urls.length; i++) {
    if (isShuttingDown) {
      const skippedVideos = urls.length - i
      console.log(`Graceful shutdown initiated. Skipping ${skippedVideos} video(s).`)
      break
    }

    const { title, filename, videoUrl } = urls[i]

    console.log('----------------------------------------')
    console.log(`Processing video ${i + 1} of ${urls.length}`)
    console.log(`URL: ${videoUrl}`)
    console.log(`Title: ${title}`)

    // Default behavior: prefix checking
    if (!options.checkFullKey) {
      for (const key of bucketObjectKeys.keys()) {
        if (key.startsWith(filename)) {
          console.log(`File with prefix "${filename}" found in bucket: "${key}". Skipping download.`)
          continue
        }
        else {
          console.log(`File with prefix "${filename}" not found in bucket. Proceeding with download.`)
        }
      }
    }

    const metadata = await getMetadata(ytdlpPath, options.ytdlpFormat, videoUrl)
    const s3ObjectKey = `${filename}.${metadata.extension}`
    const totalSizeBytes = metadata.filesize

    console.log(`File size: ${totalSizeBytes} bytes (${prettyBytes(totalSizeBytes)})`)
    console.log(`S3 object key: ${s3ObjectKey}`)
    const objectInfo = bucketObjectKeys.get(s3ObjectKey)

    if (objectInfo) {
      // This sometimes is a false positive and causes an unwanted reupload.
      // yt-dlp filesize is not always accurate.
      if (options.reuploadOnSizeDiff && objectInfo.size !== totalSizeBytes) {
        console.log(`File already exists in bucket but has different size (${objectInfo.size} bytes). Re-uploading.`)
      }
      else {
        console.log('File already exists in bucket. Skipping download.')
        continue
      }
    }
    else {
      console.log('File does not exist in bucket. Proceeding with download.')
    }

    console.log('Starting yt-dlp process')

    const ytdlpProcess = spawn(ytdlpPath, [
      '-f',
      options.ytdlpFormat,
      '-o',
      '-',
      '--no-progress',
      '--no-warnings',
      videoUrl,
    ])

    // Handle errors from yt-dlp
    ytdlpProcess.on('error', (err) => {
      console.error(`yt-dlp process error: ${err.message}`)
      process.exit(1)
    })

    // Handle errors from yt-dlp
    ytdlpProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`yt-dlp process exited with code ${code}`)
        process.exit(1)
      }
    })

    let downloadedBytes = 0
    const progressSpinner = ora(`Streaming yt-dlp to S3: 0% (0 / ${prettyBytes(totalSizeBytes)})`)

    // Track progress
    ytdlpProcess.stdout.on('data', (chunk) => {
      downloadedBytes += chunk.length
      if (!progressSpinner.isSpinning) {
        progressSpinner.start()
      }
      const progress = Math.round((downloadedBytes / totalSizeBytes) * 100)
      progressSpinner.text = `Streaming yt-dlp to S3: ${progress}% (${prettyBytes(downloadedBytes)} / ${prettyBytes(totalSizeBytes)})`
    })

    // Stop the spinner when the stream ends
    ytdlpProcess.stdout.on('end', () => {
      progressSpinner.succeed()
    })

    try {
      console.log(`Starting upload to S3`)
      await minioClient.putObject(
        options.bucket,
        s3ObjectKey,
        ytdlpProcess.stdout,
        { 'Content-Type': mime.getType(metadata.extension) || 'application/octet-stream' },
      )
      console.log(`Successfully uploaded`)
    }
    catch (err) {
      console.error(`Processing failed: ${err.message}`)
      ytdlpProcess.kill()
      process.exit(1)
    }
  }

  console.log('----------------------------------------\n')
  console.log('All done.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
