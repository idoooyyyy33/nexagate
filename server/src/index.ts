import { createServer } from 'node:http';
import { app, attachRealtime, initializeData, initializeMqtt } from './app.js';
import { config } from './config.js';
import { stopMqtt } from './services/mqtt/index.js';
import { closeSupabaseSync, startSupabaseSync } from './services/sync/supabase.js';

await initializeData();
const server = createServer(app);
const io = attachRealtime(server);
initializeMqtt(io);
startSupabaseSync();
server.listen(config.PORT, '0.0.0.0', () => console.info(`RFID API listening on port ${config.PORT}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopMqtt();
    void closeSupabaseSync();
    io.close();
    server.close(() => process.exit(0));
  });
}
