import { app } from "./app.js";
import { env } from "./config.js";

// Initialize the scheduler.
import "./lib/scheduler/index.js";


app.listen(env.PORT, () => {
  console.log(`Seijaku backend listening on http://localhost:${env.PORT}`);
});
