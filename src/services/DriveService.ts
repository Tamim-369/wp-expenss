import { google, drive_v3 } from "googleapis";
import { getAuthorizedOAuth2Client } from "./GoogleOAuth";

export class DriveService {
  private drive: drive_v3.Drive;
  private rootFolderId: string;

  constructor() {
    this.rootFolderId = process.env.GDRIVE_ROOT_FOLDER_ID as string;
    if (!this.rootFolderId) {
      throw new Error("Missing Google Drive env var: GDRIVE_ROOT_FOLDER_ID");
    }

    const hasOAuth = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    if (hasOAuth) {
      // Use OAuth (personal My Drive or Shared Drive via user)
      // Defer auth construction to async init
      // We can't do async in constructor, so create a temporary placeholder; real client will be set in ensureAuth()
      this.drive = google.drive({ version: "v3" });
    } else {
      // Fallback to Service Account (requires Shared Drive)
      const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL as string;
      const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
      if (!clientEmail || !privateKey) {
        throw new Error(
          "Missing Google Drive credentials. Provide OAuth (GOOGLE_OAUTH_CLIENT_ID/SECRET) or Service Account (GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY)."
        );
      }
      const jwt = new google.auth.JWT({
        email: clientEmail,
        key: privateKey,
        scopes: ["https://www.googleapis.com/auth/drive"],
      });
      this.drive = google.drive({ version: "v3", auth: jwt });
    }
  }

  private async ensureAuth(): Promise<void> {
    const hasOAuth = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    if (hasOAuth) {
      const auth = await getAuthorizedOAuth2Client();
      this.drive = google.drive({ version: "v3", auth });
    }
  }

  private async findChildFolderByName(parentId: string, name: string): Promise<string | null> {
    const res = await this.drive.files.list({
      q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    const found = res.data.files?.[0];
    return found?.id || null;
  }

  private async ensureFolder(parentId: string, name: string): Promise<string> {
    const existingId = await this.findChildFolderByName(parentId, name);
    if (existingId) return existingId;

    const res = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    const id = res.data.id;
    if (!id) throw new Error("Failed to create folder on Drive");
    return id;
  }

  private async ensureUserYearMonthFolders(userId: string, date: Date): Promise<string> {
    const userFolderId = await this.ensureFolder(this.rootFolderId, userId);
    const year = String(date.getFullYear());
    const yearFolderId = await this.ensureFolder(userFolderId, year);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const ym = `${year}-${month}`;
    const monthFolderId = await this.ensureFolder(yearFolderId, ym);
    return monthFolderId;
  }

  private async makeFilePublic(fileId: string): Promise<void> {
    try {
      // set permission to anyone with link can read
      await this.drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
        supportsAllDrives: true,
      });
    } catch (e) {
      // If permission already exists, ignore
      console.warn("Drive permission create warning:", (e as any)?.message || e);
    }
  }

  public async uploadImage(options: {
    buffer: Buffer;
    mimetype: string;
    filename: string;
    userId: string;
    date?: Date;
  }): Promise<{ fileId: string; webViewLink: string; directLink: string }> {
    await this.ensureAuth();
    const date = options.date || new Date();
    const parentId = await this.ensureUserYearMonthFolders(options.userId, date);

    const res = await this.drive.files.create({
      requestBody: {
        name: options.filename,
        parents: [parentId],
      },
      media: {
        mimeType: options.mimetype,
        body: Buffer.isBuffer(options.buffer)
          ? (require("stream").Readable.from(options.buffer))
          : (options.buffer as any),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    const fileId = res.data.id as string;
    if (!fileId) throw new Error("Drive upload failed: no file id");

    await this.makeFilePublic(fileId);

    const webViewLink = `https://drive.google.com/file/d/${fileId}/view`;
    const directLink = `https://drive.google.com/uc?id=${fileId}&export=view`;
    return { fileId, webViewLink, directLink };
  }

  public async deleteFile(fileId: string): Promise<void> {
    await this.ensureAuth();
    await this.drive.files.delete({ fileId, supportsAllDrives: true });
  }
}
