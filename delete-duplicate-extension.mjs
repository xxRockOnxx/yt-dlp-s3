import process from 'node:process'
import * as commander from 'commander'
import * as Minio from 'minio'
import ora from 'ora'

async function initializeMinioClient(options) {
  const minioClient = new Minio.Client({
    endPoint: options.endpoint,
    useSSL: options.ssl,
    accessKey: options.accessKey,
    secretKey: options.secretKey,
  })

  const spinner = ora(`Checking if bucket exists: ${options.bucket}`).start()
  try {
    const bucketExists = await minioClient.bucketExists(options.bucket)
    if (!bucketExists) {
      spinner.fail()
      throw new Error(`Bucket '${options.bucket}' does not exist.`)
    }
    spinner.succeed()
    return minioClient
  }
  catch (err) {
    spinner.fail(`Could not connect to bucket or bucket does not exist: ${err.message}`)
    throw err
  }
}

async function getAllObjects(minioClient, bucketName) {
  const spinner = ora('Fetching all objects in bucket...').start()
  const objects = []
  const stream = minioClient.listObjects(bucketName, '', true, { IncludeVersion: true })

  return new Promise((resolve, reject) => {
    stream.on('data', obj => objects.push(obj))
    stream.on('error', (err) => {
      spinner.fail('Failed to list objects.')
      reject(err)
    })
    stream.on('end', () => {
      spinner.succeed(`Found ${objects.length} objects in bucket '${bucketName}'.`)
      resolve(objects)
    })
  })
}

async function main() {
  const program = new commander.Command()

  program
    .requiredOption('-b, --bucket <bucket>', 'S3 bucket name')
    .requiredOption('--access-key <accessKey>', 'S3 access key', process.env.S3_ACCESS_KEY)
    .requiredOption('--secret-key <secretKey>', 'S3 secret key', process.env.S3_SECRET_KEY)
    .requiredOption('--endpoint <endpoint>', 'S3 endpoint URL')
    .requiredOption('--keep-extension <keepExtension>', 'File extension to keep (e.g., mp4, txt)')
    .option('--ssl', 'Enable SSL for S3 connection', true)
    .parse(process.argv)

  const options = program.opts()

  // Remove leading dot from extension if present
  if (options.keepExtension.startsWith('.')) {
    options.keepExtension = options.keepExtension.substring(1)
  }

  const minioClient = await initializeMinioClient(options)
  const allObjects = await getAllObjects(minioClient, options.bucket)

  const objectsToDeleteWithVersions = []
  const extensionToKeep = options.keepExtension.toLowerCase()

  for (const obj of allObjects) {
    if (!obj.name || obj.isDeleteMarker) {
      continue
    }

    const baseNameOnly = obj.name.substring(obj.name.lastIndexOf('/') + 1)
    const parts = baseNameOnly.split('.')
    let shouldDelete = false

    // File has an extension
    if (parts.length > 1) {
      const currentExtension = parts.pop().toLowerCase()
      if (currentExtension !== extensionToKeep) {
        shouldDelete = true
      }
    }
    else {
      // Delete if no extension, as we are keeping a specific one
      shouldDelete = true
    }

    if (shouldDelete) {
      if (obj.versionId) {
        objectsToDeleteWithVersions.push({ name: obj.name, versionId: obj.versionId })
      }
      else {
        objectsToDeleteWithVersions.push({ name: obj.name })
      }
    }
  }

  if (objectsToDeleteWithVersions.length === 0) {
    ora(`No object versions found to delete. All objects either have the extension '.${options.keepExtension}' or the bucket is empty/contains only matching files.`).succeed()
    return
  }

  const totalToDelete = objectsToDeleteWithVersions.length
  const deleteSpinner = ora(`Deleting ${totalToDelete} object version(s) that are not '.${options.keepExtension}' or have no extension.`).start()

  try {
    await minioClient.removeObjects(options.bucket, objectsToDeleteWithVersions)
    deleteSpinner.succeed()
    console.log('Deleted objects and versions:')
    objectsToDeleteWithVersions.forEach((obj) => {
      console.log(` - ${obj.name}${obj.versionId ? ` (Version ID: ${obj.versionId})` : ' (current/unversioned)'}`)
    })
  }
  catch (err) {
    deleteSpinner.fail()
    console.error('Error details:', err)
    process.exit(1)
  }

  console.log('\nAll done.')
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
