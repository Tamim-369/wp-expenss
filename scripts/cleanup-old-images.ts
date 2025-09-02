import 'dotenv/config';
import mongoose from 'mongoose';
import { Expense } from '../src/models/ExpenseModel';
import { CloudinaryService } from '../src/services/CloudinaryService';

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI is required');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('✅ Connected to MongoDB');

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  console.log(`🧹 Cleaning images older than ${cutoffStr}`);

  let cloud: CloudinaryService | null = null;
  try {
    cloud = new CloudinaryService();
  } catch (e) {
    console.warn('Cloudinary not configured. Cloudinary deletions will be skipped.');
  }

  const cursor = Expense.find({
    imageUrl: { $exists: true, $ne: '' },
    imageDeletedAt: { $exists: false },
    date: { $lt: cutoffStr },
  }).cursor();

  let processed = 0;
  let deleted = 0;
  let errors = 0;

  for await (const exp of cursor) {
    processed++;
    try {
      const provider = (exp as any).imageProvider as 'drive' | 'cloudinary' | undefined;
      const ref = (exp as any).imageRef as string | undefined;

      if (provider === 'cloudinary' && ref) {
        if (cloud) {
          try {
            await cloud.deleteImage(ref);
            deleted++;
            console.log(`🗑️ Deleted Cloudinary image ${ref} for expense #${exp.number} (${exp.userId})`);
          } catch (e) {
            errors++;
            console.error(`❌ Failed to delete Cloudinary image ${ref}:`, e);
          }
        } else {
          console.warn(`⚠️ Cloudinary not configured; skipping deletion for ${ref}`);
        }
      } else {
        console.warn(`⚠️ Missing provider/ref for expense #${exp.number}; skipping remote deletion`);
      }

      await Expense.updateOne(
        { _id: exp._id },
        {
          $set: { imageDeletedAt: new Date() },
          $unset: { imageUrl: 1, imageRef: 1, imageProvider: 1 },
        }
      );
    } catch (e) {
      errors++;
      console.error('❌ Error processing expense', exp._id?.toString(), e);
    }
  }

  console.log(`✅ Done. Processed: ${processed}, Deleted: ${deleted}, Errors: ${errors}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('❌ Fatal error in cleanup:', e);
  process.exit(1);
});
