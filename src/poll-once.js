// One-shot poll (no server). Useful for cron-based setups or testing collectors.
import { pollAll } from "./collectors.js";
const counts = await pollAll({ force: true });
console.log("[poll-once] complete:", counts);
process.exit(0);
