import { config } from "dotenv";
import { startServer } from "./server";

config();

async function startApp() {
  console.log("🚀 Starting WhatsApp Cloud API server...");
  await startServer();
}

startApp().catch((error) => {
  console.error("❌ Failed to start bot:", error);
  process.exit(1);
});
