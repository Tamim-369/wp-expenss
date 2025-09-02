import { runInteractiveAuth } from "../src/services/GoogleOAuth";

(async () => {
  try {
    await runInteractiveAuth();
    console.log("All set. You can now run the bot and upload to your personal Drive.");
  } catch (e:any) {
    console.error("Auth failed:", e?.message || e);
    process.exit(1);
  }
})();
