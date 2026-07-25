import { LobbyServer } from './core/LobbyServer.js';

/** Default game-server port. 8080 is a magnet for local proxies/content filters
 *  (one such filter replays the first client TCP segment into the stream, which
 *  kills every WebSocket on that port with an RSV1 error), so the default lives
 *  on 8090. PORT still wins for deploys that pin a port. */
const DEFAULT_PORT = 8090;
const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
const server = new LobbyServer();
server.init(port);
