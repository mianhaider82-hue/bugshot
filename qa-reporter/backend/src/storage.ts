/**
 * Screenshot storage on Cloudinary. The returned secure URL is public but
 * unguessable, so anyone with the spreadsheet row can open the image.
 */

import { v2 as cloudinary, type UploadApiErrorResponse } from 'cloudinary';
import { config } from './config.js';

let configured = false;

function client(): typeof cloudinary {
  if (!configured) {
    cloudinary.config({
      cloud_name: config.cloudinary.cloudName,
      api_key: config.cloudinary.apiKey,
      api_secret: config.cloudinary.apiSecret,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

export function isCloudinaryError(err: unknown): err is UploadApiErrorResponse {
  return typeof (err as { http_code?: unknown })?.http_code === 'number';
}

export async function uploadScreenshot(reportId: string, dataUrl: string): Promise<string> {
  if (!/^data:image\/[a-z]+;base64,/.test(dataUrl)) throw new Error('image must be a base64 data URL');
  const res = await client().uploader.upload(dataUrl, {
    folder: config.cloudinary.folder,
    public_id: `${reportId}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    resource_type: 'image',
    overwrite: false,
  });
  return res.secure_url;
}
