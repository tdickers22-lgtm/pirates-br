import { GameServer } from './core/GameServer.js';

const args = process.argv.slice(2);
const useBots = args.includes('--bots');
const botCountArg = args.find(a => a.startsWith('--bot-count='));
const botCount = botCountArg ? parseInt(botCountArg.split('=')[1], 10) : (useBots ? 6 : 6);
const port = parseInt(process.env.PORT ?? '8080', 10);

const server = new GameServer();
server.init(port, botCount);
