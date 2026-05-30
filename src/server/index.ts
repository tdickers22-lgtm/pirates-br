import { LobbyServer } from './core/LobbyServer.js';

const port = parseInt(process.env.PORT ?? '8080', 10);
const server = new LobbyServer();
server.init(port);
