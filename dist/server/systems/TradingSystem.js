import { v4 as uuid } from 'uuid';
const TRADE_RANGE = 50;
const TRADE_TIMEOUT = 15;
const BETRAYAL_WINDOW = 2;
export class TradingSystem {
    update(dt, sessions, ships, players) {
        const events = [];
        for (let index = sessions.length - 1; index >= 0; index--) {
            const session = sessions[index];
            const initiator = players.find((candidate) => candidate.id === session.initiatorId);
            const targetPlayer = players.find((candidate) => candidate.id === session.targetPlayerId);
            const initiatorShip = ships.find((candidate) => candidate.id === session.initiatorShipId && candidate.alive);
            const targetShip = ships.find((candidate) => candidate.id === session.targetShipId && candidate.alive);
            if (!initiator || !targetPlayer || !initiatorShip || !targetShip || ['eliminated', 'respawning'].includes(initiator.state) || ['eliminated', 'respawning'].includes(targetPlayer.state)) {
                events.push({
                    type: 'trade_rejected',
                    sessionId: session.id,
                    initiatorId: session.initiatorId,
                    targetShipId: session.targetShipId,
                });
                sessions.splice(index, 1);
                continue;
            }
            this.maybeHandleBotTrade(session, ships, players, events);
            session.timer -= dt;
            if (session.betrayalWindow) {
                if (!session.botBetrayalChecked) {
                    session.botBetrayalChecked = true;
                    if (targetPlayer.isBot && Math.random() < 0.2) {
                        events.push({
                            type: 'trade_betrayed',
                            sessionId: session.id,
                            initiatorId: session.initiatorId,
                            targetShipId: session.targetShipId,
                            byPlayerId: targetPlayer.id,
                        });
                        sessions.splice(index, 1);
                        continue;
                    }
                }
                if (session.timer <= 0) {
                    this.executeTrade(session, ships, players);
                    events.push({
                        type: 'trade_completed',
                        sessionId: session.id,
                        initiatorId: session.initiatorId,
                        targetShipId: session.targetShipId,
                    });
                    sessions.splice(index, 1);
                }
                continue;
            }
            if (session.initiatorConfirmed && session.targetConfirmed) {
                session.betrayalWindow = true;
                session.timer = BETRAYAL_WINDOW;
                events.push({
                    type: 'trade_update',
                    sessionId: session.id,
                    initiatorId: session.initiatorId,
                    targetShipId: session.targetShipId,
                    session: this.cloneSession(session),
                });
                continue;
            }
            if (session.timer <= 0) {
                events.push({
                    type: 'trade_timeout',
                    sessionId: session.id,
                    initiatorId: session.initiatorId,
                    targetShipId: session.targetShipId,
                });
                sessions.splice(index, 1);
            }
        }
        return events;
    }
    requestTrade(initiator, targetShip, sessions) {
        if (!initiator.onShipId)
            return null;
        const dx = initiator.position.x - targetShip.position.x;
        const dz = initiator.position.z - targetShip.position.z;
        if (Math.sqrt(dx * dx + dz * dz) > TRADE_RANGE)
            return null;
        if (sessions.some((session) => session.initiatorId === initiator.id ||
            session.targetPlayerId === initiator.id ||
            session.initiatorShipId === initiator.onShipId ||
            session.targetShipId === targetShip.id)) {
            return null;
        }
        const session = {
            id: uuid(),
            initiatorId: initiator.id,
            initiatorShipId: initiator.onShipId,
            targetPlayerId: targetShip.ownerId,
            targetShipId: targetShip.id,
            initiatorOffer: [],
            targetOffer: [],
            initiatorConfirmed: false,
            targetConfirmed: false,
            timer: TRADE_TIMEOUT,
            betrayalWindow: false,
            botDecisionMade: false,
            botBetrayalChecked: false,
        };
        sessions.push(session);
        return session;
    }
    setOffer(sessionId, playerId, offer, sessions, ships, players) {
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session)
            return null;
        const player = players.find((candidate) => candidate.id === playerId);
        if (!player)
            return null;
        if (session.initiatorId === playerId) {
            const ship = ships.find((candidate) => candidate.id === session.initiatorShipId);
            if (!ship)
                return null;
            session.initiatorOffer = this.sanitizeOffer(offer, player, ship);
        }
        else if (session.targetPlayerId === playerId) {
            const ship = ships.find((candidate) => candidate.id === session.targetShipId);
            if (!ship)
                return null;
            session.targetOffer = this.sanitizeOffer(offer, player, ship);
        }
        else {
            return null;
        }
        session.initiatorConfirmed = false;
        session.targetConfirmed = false;
        session.betrayalWindow = false;
        session.botBetrayalChecked = false;
        session.timer = TRADE_TIMEOUT;
        return session;
    }
    confirmTrade(sessionId, playerId, sessions) {
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session)
            return null;
        if (session.initiatorId === playerId) {
            session.initiatorConfirmed = true;
            return session;
        }
        if (session.targetPlayerId === playerId) {
            session.targetConfirmed = true;
            return session;
        }
        return null;
    }
    cancelTrade(sessionId, playerId, sessions) {
        const index = sessions.findIndex((candidate) => candidate.id === sessionId);
        if (index < 0)
            return null;
        const session = sessions[index];
        if (session.initiatorId !== playerId && session.targetPlayerId !== playerId) {
            return null;
        }
        sessions.splice(index, 1);
        return {
            type: session.betrayalWindow ? 'trade_betrayed' : 'trade_rejected',
            sessionId: session.id,
            initiatorId: session.initiatorId,
            targetShipId: session.targetShipId,
            byPlayerId: playerId,
        };
    }
    sanitizeOffer(offer, player, ship) {
        const sanitized = [];
        const seen = new Set();
        for (const entry of offer) {
            if (!entry || seen.has(entry.item) || entry.qty <= 0)
                continue;
            seen.add(entry.item);
            if (entry.item === 'gold') {
                sanitized.push({ item: 'gold', qty: Math.min(entry.qty, player.gold) });
                continue;
            }
            const stack = ship.inventory.find((candidate) => candidate.item === entry.item);
            if (!stack)
                continue;
            sanitized.push({ item: entry.item, qty: Math.min(entry.qty, stack.qty) });
        }
        return sanitized.filter((entry) => entry.qty > 0);
    }
    maybeHandleBotTrade(session, ships, players, events) {
        if (session.botDecisionMade || session.betrayalWindow)
            return;
        const targetPlayer = players.find((candidate) => candidate.id === session.targetPlayerId);
        if (!targetPlayer?.isBot)
            return;
        if (session.timer > TRADE_TIMEOUT - 1.25)
            return;
        session.botDecisionMade = true;
        if (Math.random() >= 0.3) {
            session.timer = 0.01;
            return;
        }
        const targetShip = ships.find((candidate) => candidate.id === session.targetShipId);
        if (!targetShip)
            return;
        session.targetOffer = this.buildBotOffer(targetPlayer, targetShip);
        session.targetConfirmed = true;
        events.push({
            type: 'trade_update',
            sessionId: session.id,
            initiatorId: session.initiatorId,
            targetShipId: session.targetShipId,
            session: this.cloneSession(session),
        });
    }
    buildBotOffer(player, ship) {
        const offer = [];
        if (player.gold >= 100 && Math.random() < 0.5) {
            offer.push({ item: 'gold', qty: Math.min(150, player.gold) });
        }
        const barterable = ship.inventory
            .filter((entry) => ['cannonball', 'wood_plank', 'firebomb_ball', 'chainshot', 'banana'].includes(entry.item))
            .sort((left, right) => right.qty - left.qty);
        if (barterable[0]) {
            offer.push({
                item: barterable[0].item,
                qty: Math.min(barterable[0].qty, barterable[0].item === 'cannonball' ? 6 : 2),
            });
        }
        return offer;
    }
    executeTrade(session, ships, players) {
        const initiator = players.find((player) => player.id === session.initiatorId);
        const targetPlayer = players.find((player) => player.id === session.targetPlayerId);
        const initiatorShip = ships.find((ship) => ship.id === session.initiatorShipId);
        const targetShip = ships.find((ship) => ship.id === session.targetShipId);
        if (!initiator || !targetPlayer || !initiatorShip || !targetShip)
            return;
        this.transferOffer(session.initiatorOffer, initiator, initiatorShip, targetPlayer, targetShip);
        this.transferOffer(session.targetOffer, targetPlayer, targetShip, initiator, initiatorShip);
    }
    transferOffer(offer, fromPlayer, fromShip, toPlayer, toShip) {
        for (const stack of offer) {
            if (stack.item === 'gold') {
                const moved = Math.min(fromPlayer.gold, stack.qty);
                fromPlayer.gold -= moved;
                toPlayer.gold += moved;
                continue;
            }
            const source = fromShip.inventory.find((entry) => entry.item === stack.item);
            if (!source)
                continue;
            const moved = Math.min(source.qty, stack.qty);
            source.qty -= moved;
            if (source.qty <= 0) {
                fromShip.inventory = fromShip.inventory.filter((entry) => entry !== source);
            }
            const destination = toShip.inventory.find((entry) => entry.item === stack.item);
            if (destination) {
                destination.qty += moved;
            }
            else {
                toShip.inventory.push({ item: stack.item, qty: moved });
            }
        }
    }
    cloneSession(session) {
        return JSON.parse(JSON.stringify(session));
    }
}
