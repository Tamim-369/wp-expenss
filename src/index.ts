import { config } from "dotenv";
import { WhatsAppClient } from "./services/WhatsAppClient";

config();

async function startApp() {
  console.log("🚀 Starting WhatsApp Expense Tracker...");
  const bot = new WhatsAppClient();
  await bot.start();
}

startApp().catch((error) => {
  console.error("❌ Failed to start bot:", error);
  process.exit(1);
});
