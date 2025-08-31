import { Hono } from 'hono';
import type { Context } from 'hono';
import { WhatsAppCloudAdapter } from './adapters/WhatsAppCloudAdapter';
import { ExpenseService } from './services/ExpenseService';
import { ExcelService } from './services/ExcelService';
import { MongoService } from './services/MongoService';
import { Message, MessageMedia } from './types/wa';
import mongoose from 'mongoose';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const GRAPH_VERSION = process.env.WABA_API_VERSION || 'v20.0';

if (!process.env.GROQ_API_KEY || !process.env.MONGO_URI || !ACCESS_TOKEN || !PHONE_NUMBER_ID || !VERIFY_TOKEN) {
  console.error('❌ Missing required environment variables. Required: GROQ_API_KEY, MONGO_URI, META_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, META_VERIFY_TOKEN');
  process.exit(1);
}

async function connectToMongo() {
  await mongoose.connect(process.env.MONGO_URI!, { dbName: 'expense_tracker' });
  console.log('✅ Connected to MongoDB');
}

const adapter = new WhatsAppCloudAdapter({ accessToken: ACCESS_TOKEN, phoneNumberId: PHONE_NUMBER_ID });
const mongoService = new MongoService();
const expenseService = new ExpenseService(adapter);
const excelService = new ExcelService(adapter);

// Dedup store for webhook message IDs
const processed = new Set<string>();

async function downloadMediaById(mediaId: string): Promise<MessageMedia> {
  // Step 1: Get media URL
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(`Media meta fetch failed: ${metaRes.status}`);
  const metaJson = await metaRes.json() as { url: string; mime_type?: string; file_size?: number; id: string };

  // Step 2: Download binary with token in header
  const binRes = await fetch(metaJson.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!binRes.ok) throw new Error(`Media download failed: ${binRes.status}`);
  const arrayBuffer = await binRes.arrayBuffer();
  const b64 = Buffer.from(arrayBuffer).toString('base64');
  const mimetype = metaJson.mime_type || 'application/octet-stream';
  return new MessageMedia(mimetype, b64);
}

function makeMessageShim(params: { from: string; text?: string; mediaId?: string; caption?: string }): Message {
  const { from, text, mediaId, caption } = params;
  const hasMedia = !!mediaId;
  const body = (text || caption || '').toString();
  const msg: Message = { from, body, hasMedia };
  if (hasMedia) {
    msg.downloadMedia = async () => {
      try {
        return await downloadMediaById(mediaId!);
      } catch (e) {
        console.error('❌ Failed to download media', e);
        return null;
      }
    };
  }
  return msg;
}

const app = new Hono();

// Verify webhook (GET)
app.get('/webhook', (c: Context) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return c.body(challenge || '', 200);
  }
  return c.text('Forbidden', 403);
});

// Receive messages (POST)
app.post('/webhook', async (c: Context) => {
  const payload = await c.req.json();
  try {
    const entries = payload.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const contact = contacts[i] || contacts[0];
          const from = msg.from || contact?.wa_id;
          const msgId = msg.id;

          if (!from || !msgId) continue;
          if (processed.has(msgId)) continue;
          processed.add(msgId);
          if (processed.size > 2000) {
            // trim set
            const toDelete = Array.from(processed).slice(0, 1000);
            toDelete.forEach((id) => processed.delete(id));
          }

          // Only handle user messages (ignore statuses)
          if (msg.type === 'text' && msg.text?.body) {
            const shim = makeMessageShim({ from, text: msg.text.body });
            await routeMessage(shim);
          } else if (msg.type === 'image') {
            const caption = msg.image?.caption || '';
            const mediaId = msg.image?.id;
            const shim = makeMessageShim({ from, caption, mediaId });
            await routeMessage(shim);
          } else if (msg.type === 'document') {
            // Not used in current flows; ignore or send help
            const shim = makeMessageShim({ from, text: 'help' });
            await routeMessage(shim);
          } else {
            // Unsupported types -> send hint
            await adapter.sendMessage(from, 'Unsupported message type. Please send text like "Grocery 100" or an image of a receipt.');
          }
        }
      }
    }
  } catch (e) {
    console.error('❌ Webhook processing error:', e);
  }
  return c.json({ status: 'ok' });
});

async function routeMessage(message: Message) {
  try {
    const userId = message.from;
    const text = (message.body || '').toLowerCase();

    // State machine from WhatsAppClient.handleMessage, simplified entry
    const userState = await mongoService.getUserState(userId);

    // Excel exports
    if (
      userState === 'active' &&
      (text.includes('send expense info') ||
        text.includes('give excel file') ||
        text.includes('give my expense data') ||
        text.includes('expnese in excel') ||
        text.includes('expnese in sheet') ||
        text.includes('excel sheet') ||
        text.includes('google sheets') ||
        text.includes('monthly spend data') ||
        text.includes('full expense data') ||
        text.includes('all expense') ||
        text === 'report' ||
        text.includes('this month') ||
        text.includes('this year'))
    ) {
      await excelService.sendExcelFile(userId, message);
      return;
    }

    if (userState === 'active' && /^budget\s+\d+/i.test(text)) {
      // reuse service method via WhatsAppClient logic is private; inline minimal here
      const match = message.body?.match(/budget\s+(\d+(?:\.\d+)?)/i);
      if (match) {
        const newBudget = parseFloat(match[1]!);
        const currency = await mongoService.getUserCurrency(userId);
        await mongoService.setMonthlyBudgetWithCurrency(userId, newBudget, currency);
        const month = new Date().toLocaleString('default', { month: 'long' });
        const year = new Date().getFullYear();
        await adapter.sendMessage(userId, `Budget set to ${newBudget.toFixed(2)} ${currency} for ${month} ${year} ✅`);
        return;
      }
    }

    if (userState === 'active' && /^currency\s+\w+/i.test(text)) {
      const match = message.body?.match(/currency\s+(\w+)/i);
      if (match) {
        const requested = match[1]!;
        const { CurrencyService } = await import('./services/CurrencyService');
        const detected = CurrencyService.detectCurrency(requested);
        if (detected) {
          const currentCurrency = await mongoService.getUserCurrency(userId);
          await mongoService.setPendingCurrency(userId, detected);
          await adapter.sendMessage(userId, `Change currency to ${detected}? Existing entries stay in ${currentCurrency}.\nReply YES to confirm.`);
        } else {
          await adapter.sendMessage(userId, '❌ Invalid currency. Examples: USD, EUR, INR, BDT, Taka, Rupee, Dollar');
        }
        return;
      }
    }

    if (userState === 'active' && text === 'help') {
      const helpMessage = `*Quick Commands:*\n\n📝 *Add:* Grocery 100\n✏️ *Edit:* #001 Edit 80\n🗑️ *Delete:* #001 Delete\n💰 *Budget:* Budget 30000\n💱 *Currency:* Currency BDT\n📊 *Report:* Report (Excel file)\n📷 *Scan:* Send a receipt photo (optional caption like Food)\n🙋 *Help:* Help`;
      await adapter.sendMessage(userId, helpMessage);
      return;
    }

    if (userState === 'new') {
      const month = new Date().toLocaleString('default', { month: 'long' });
      await adapter.sendMessage(userId, `👋 👋 Welcome to the ${month} Budget Challenge!\nFirst, tell me your preferred currency.\n👉 Example: AED, USD, INR`);
      await mongoService.setUserState(userId, 'awaiting_currency');
      return;
    }

    if (userState === 'awaiting_budget') {
      const numeric = parseFloat((message.body || '').trim());
      if (!isNaN(numeric)) {
        const userCurrency = await mongoService.getUserCurrency(userId);
        await mongoService.setMonthlyBudgetWithCurrency(userId, numeric, userCurrency);
        await mongoService.setUserState(userId, 'active');
        const month = new Date().toLocaleString('default', { month: 'long' });
        const year = new Date().getFullYear();
        await adapter.sendMessage(userId, `Budget set to ${numeric.toFixed(2)} ${userCurrency} for ${month} ${year} ✅\n\nNow add your first expense. Example: Grocery 100`);
      } else {
        const userCurrency = await mongoService.getUserCurrency(userId);
        await adapter.sendMessage(userId, `Please enter a valid number only.\n👉 Example: If your budget is 2000 ${userCurrency}, type 2000`);
      }
      return;
    }

    if (userState === 'awaiting_currency') {
      const { CurrencyService } = await import('./services/CurrencyService');
      const detected = CurrencyService.detectCurrency(message.body || '');
      if (detected) {
        await mongoService.setUserCurrency(userId, detected);
        await mongoService.setUserState(userId, 'awaiting_budget');
        await adapter.sendMessage(userId, `Great! We’ll use ${detected} for your budget.\nYour monthly budget?\n👉 Example: If your budget is 2000 ${detected}, type 2000`);
      } else {
        await adapter.sendMessage(userId, 'Please enter a valid currency. Examples: USD, EUR, INR, BDT, Taka, Rupee, Dollar');
      }
      return;
    }

    if (userState === 'awaiting_currency_change') {
      const normalized = (message.body || '').trim().toLowerCase();
      if (normalized === 'yes' || normalized === 'y') {
        const newCurrency = await mongoService.confirmCurrencyChange(userId);
        if (newCurrency) await adapter.sendMessage(userId, `Done. New entries will use ${newCurrency}.`);
      } else if (normalized === 'no' || normalized === 'n') {
        await mongoService.clearPendingCurrency(userId);
        await adapter.sendMessage(userId, 'Okay, cancelled the currency change.');
      } else {
        await adapter.sendMessage(userId, 'Please reply with YES to confirm or NO to cancel the currency change.');
      }
      return;
    }

    // Active user: media first
    if (userState === 'active' && message.hasMedia && message.downloadMedia) {
      const media = await message.downloadMedia();
      if (media && media.mimetype.startsWith('image/')) {
        await expenseService.processImageMessage(media, message.body || '', message, mongoService);
      } else {
        await adapter.sendMessage(userId, '❌ Sorry, only images are supported for expense tracking. Please send an image of a receipt.');
      }
      return;
    }

    // Text expense
    if (userState === 'active' && (message.body || '').trim()) {
      const trimmed = (message.body || '').trim();
      const hasNumber = /\d/.test(trimmed);
      const hasText = /[a-zA-Z]/.test(trimmed);
      if (hasNumber && hasText) {
        await expenseService.processExpenseMessage(trimmed, message, mongoService);
      } else {
        await adapter.sendMessage(userId, `Didn’t get that. Try: Grocery 100.\nWant quick commands? Reply: Help`);
      }
      return;
    }
  } catch (e) {
    console.error('❌ Error in routeMessage:', e);
    await adapter.sendMessage(message.from, 'Sorry, there was an error processing your message. Please try again.');
  }
}

export async function startServer() {
  await connectToMongo();
  const port = Number(process.env.PORT || 3000);
  console.log(`🚀 Starting Hono server on port ${port}`);
  Bun.serve({ fetch: app.fetch, port });
}
