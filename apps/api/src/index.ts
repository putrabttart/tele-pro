import { app } from "./app";
import { env } from "./config/env";

app.listen(env.API_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API running on port ${env.API_PORT}`);
});
