import dotenv from "dotenv";
import { createApp } from "./app.js";
import { startEmailScheduler } from "./lib/emailAutomation.js";

dotenv.config();

const app = createApp();
const port = Number(process.env.PORT || 5000);

app.listen(port, () => {
  console.log(`Backend running on ${port}`);
  startEmailScheduler();
});
