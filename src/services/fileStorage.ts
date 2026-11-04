import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';

const storageDirectory = path.resolve(
  process.env.DATA_STORAGE_DIR || path.join(process.cwd(), 'uploads')
);
const usesRenderDisk =
  storageDirectory === '/var/data' || storageDirectory.startsWith('/var/data/');

const bucketName = process.env.AWS_S3_BUCKET?.trim();
const awsRegion = process.env.AWS_REGION?.trim() || 'ap-south-1';
const hasAwsCredentials = Boolean(
  process.env.AWS_ACCESS_KEY_ID?.trim() &&
  process.env.AWS_SECRET_ACCESS_KEY?.trim()
);
const s3Client = bucketName && hasAwsCredentials
  ? new S3Client({
      region: awsRegion,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
      }
    })
  : null;

function safeFileName(fileName: string) {
  const baseName = path.basename(fileName || 'dataset.csv');
  return baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'dataset.csv';
}

function safeJobId(jobId: string) {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function storeUploadedDataset(
  jobId: string,
  fileName: string,
  content: Buffer,
  contentType: string
) {
  const safeName = safeFileName(fileName);
  const relativeKey = path.posix.join('uploads', safeJobId(jobId), safeName);

  if (s3Client && bucketName) {
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: relativeKey,
      Body: content,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
      Metadata: {
        jobid: safeJobId(jobId),
        originalfilename: safeName
      }
    }));
    return {
      provider: 'amazon-s3' as const,
      objectKey: relativeKey
    };
  }

  const destination = path.resolve(storageDirectory, relativeKey);
  if (!destination.startsWith(`${storageDirectory}${path.sep}`)) {
    throw new Error('Invalid dataset storage path.');
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.uploading`;
  await fs.writeFile(temporaryPath, content);
  await fs.rename(temporaryPath, destination);
  await fs.writeFile(`${destination}.metadata.json`, JSON.stringify({
    fileName: safeName,
    contentType,
    size: content.length,
    uploadedAt: new Date().toISOString()
  }, null, 2));

  return {
    provider: usesRenderDisk ? 'render-persistent-disk' as const : 'local-filesystem' as const,
    objectKey: relativeKey
  };
}

export async function getStoredDataset(objectKey: string): Promise<Buffer> {
  if (objectKey.includes('..') || objectKey.startsWith('/') || objectKey.includes('\\\\')) {
    throw new Error('Invalid dataset storage key.');
  }

  if (s3Client && bucketName) {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey
    }));
    if (!response.Body) throw new Error('The stored dataset has no readable content.');
    return Buffer.from(await response.Body.transformToByteArray());
  }

  const destination = path.resolve(storageDirectory, objectKey);
  if (!destination.startsWith(`${storageDirectory}${path.sep}`)) {
    throw new Error('Invalid dataset storage path.');
  }
  return fs.readFile(destination);
}

export async function deleteStoredDataset(objectKey: string): Promise<void> {
  if (objectKey.includes('..') || objectKey.startsWith('/') || objectKey.includes('\\\\')) {
    throw new Error('Invalid dataset storage key.');
  }

  if (s3Client && bucketName) {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }));
    return;
  }

  const destination = path.resolve(storageDirectory, objectKey);
  if (!destination.startsWith(`${storageDirectory}${path.sep}`)) {
    throw new Error('Invalid dataset storage path.');
  }
  await fs.rm(destination, { force: true });
  await fs.rm(`${destination}.metadata.json`, { force: true });
}

export function fileStorageStatus() {
  if (s3Client && bucketName) {
    return {
      configured: true,
      provider: 'Amazon S3',
      bucket: bucketName,
      region: awsRegion,
      persistent: true
    };
  }
  return {
    configured: true,
    provider: usesRenderDisk ? 'Render Persistent Disk' : 'Local filesystem',
    storageDirectory,
    persistent: usesRenderDisk,
    awsConfigured: false
  };
}
