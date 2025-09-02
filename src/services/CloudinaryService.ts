import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

export class CloudinaryService {
  private enabled: boolean;

  constructor() {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    this.enabled = !!(cloudName && apiKey && apiSecret);

    if (this.enabled) {
      cloudinary.config({
        cloud_name: cloudName!,
        api_key: apiKey!,
        api_secret: apiSecret!,
        secure: true,
      });
    } else {
      throw new Error('Cloudinary not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
    }
  }

  public isEnabled() {
    return this.enabled;
  }

  public async uploadImage(options: {
    buffer: Buffer;
    mimetype: string;
    filename: string; // without folder prefix
    userId: string;
    date?: Date;
  }): Promise<{ publicId: string; secureUrl: string }> {
    const date = options.date || new Date();
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const folder = `${options.userId}/${yyyy}/${yyyy}-${mm}`;
    const publicId = `${folder}/${options.filename.replace(/^\/+/, '')}`.replace(/\.+$/,'').replace(/\s+/g,'_');

    const res: UploadApiResponse = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: options.filename.replace(/\.[^.]+$/, ''),
          resource_type: 'image',
          overwrite: false,
        },
        (error: unknown, result: unknown) => {
          if (error) return reject(error);
          resolve(result as UploadApiResponse);
        }
      );
      stream.end(options.buffer);
    });

    if (!res.public_id || !res.secure_url) {
      throw new Error('Cloudinary upload failed');
    }

    return { publicId: res.public_id, secureUrl: res.secure_url };
  }

  public async deleteImage(publicId: string): Promise<void> {
    const res = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    if (res.result !== 'ok' && res.result !== 'not found') {
      throw new Error(`Cloudinary delete failed: ${res.result}`);
    }
  }
}
