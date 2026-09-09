/**
 * rules.js — 8-ball rules on top of the physics world.
 *
 * Implements the common bar/BCA-flavoured rule set:
 *   - open table after the break, groups assigned on the first legal pot
 *   - a legal shot must hit your own group first and either pot a ball or
 *     drive a ball to a cushion afterwards
 *   - any foul gives the opponent ball in hand
 *   - potting the 8 before clearing your group loses; potting it legally wins
 *
 * Pure JS, no DOM, so it can be unit-tested in node.
 */

import { BALL_RADIUS, FOOT_SPOT, HALF_L, HALF_W, isValidCuePosition, pocketAt } from './physics.js';

export const OPEN = 'open';
export const SOLIDS = 'solids';
export const STRIPES = 'stripes';

export const groupOfBall = (id) => {
  if (id === 0) return 'cue';
  if (id === 8) return 'eight';
  return id < 8 ? SOLIDS : STRIPES;
};

export const groupLabel = (g) => (g === SOLIDS ? 'Solids' : g === STRIPES ? 'Stripes' : 'Open table');

export class EightBallGame {
  constructor(world, playerNames = ['Player 1', 'Player 2']) {
    this.world = world;
    this.players = playerNames.map((name, i) => ({ name, index: i, group: null }));
    this.turn = 0;
    this.openTable = true;
    this.ballInHand = false;
    this.ballInHandKitchen = false; // after a break scratch, must play from behind the head string
    this.breakDone = false;
    this.gameOver = false;
    this.winner = null;
    this.message = 'Break to start.';
    this.detail = '';
    this.lastShot = null;
    this.turnCount = 1;
  }

  get currentPlayer() {
    return this.players[this.turn];
  }

  get opponent() {
    return this.players[1 - this.turn];
  }

  /** Balls this player must hit next (empty array = open table). */
  targetsFor(playerIndex) {
    const g = this.players[playerIndex].group;
    if (!g || this.openTable) return [];
    return this.world.balls
      .filter((b) => b.active && groupOfBall(b.id) === g)
      .map((b) => b.id);
  }

  /** The ball id the shooter must contact first (null = anything legal). */
  requiredFirstHit() {
    const p = this.currentPlayer;
    if (this.openTable || !p.group) return null;
    const remaining = this.targetsFor(this.turn);
    if (remaining.length === 0) return 8;
    return remaining;
  }

  /**
   * Judge a completed shot.
   * Returns { foul, foulReason, continueTurn, gameOver, winner, potted }.
   */
  evaluateShot() {
    const shot = this.world.shot;
    const potted = shot.potted.slice();
    const cuePotted = potted.includes(0);
    const objectPotted = potted.filter((id) => id !== 0);
    const eightPotted = potted.includes(8);
    const isBreak = !this.breakDone;
    const player = this.currentPlayer;
    const opponent = this.opponent;

    let foul = false;
    let foulReason = '';
    let continueTurn = false;
    let won = null;

    const setFoul = (reason) => {
      if (!foul) {
        foul = true;
        foulReason = reason;
      }
    };

    // ---- 1. did the cue ball hit anything? -------------------------------
    if (shot.firstHit === null) {
      setFoul('cue ball hit nothing');
    } else if (isBreak) {
      // A break just has to reach the rack; the 4-ball rule is checked below.
      if (objectPotted.length === 0 && shot.railBalls.size < 4) {
        setFoul('illegal break — not enough balls reached a rail');
      }
    } else if (!this.openTable && player.group) {
      const need = this.requiredFirstHit();
      const needed = Array.isArray(need) ? need : [need];
      if (!needed.includes(shot.firstHit)) {
        setFoul(
          needed.length === 1 && needed[0] === 8
            ? 'must hit the 8-ball first'
            : `must hit ${groupLabel(player.group).toLowerCase()} first`,
        );
      }
    }

    // ---- 2. rail after contact ------------------------------------------
    if (!foul && !shot.railAfterContact && objectPotted.length === 0) {
      setFoul('no ball reached a cushion');
    }

    // ---- 3. scratch ------------------------------------------------------
    if (cuePotted) setFoul('scratch — cue ball pocketed');

    // ---- 4. the 8-ball decides the game ---------------------------------
    if (eightPotted) {
      if (isBreak) {
        // Potting the 8 on the break is not a win or a loss: it is re-spotted.
        this.respotBall(8);
        this.message = 'The 8-ball goes back on the spot.';
        this.detail = cuePotted ? 'Scratch on the break — ball in hand.' : 'Break continues.';
        this.breakDone = true;
        this.applyFoulOrPass(foul, false, cuePotted, isBreak);
        return this.finish(foul, foulReason, false, null, potted);
      }
      const cleared = player.group ? this.targetsFor(this.turn).length === 0 : false;
      if (!player.group || this.openTable) {
        won = opponent.index; // potting the 8 on an open table loses
        this.message = `${player.name} pocketed the 8-ball too early.`;
        this.detail = `${opponent.name} wins the game.`;
      } else if (!cleared) {
        won = opponent.index;
        this.message = `${player.name} pocketed the 8-ball with balls still on the table.`;
        this.detail = `${opponent.name} wins the game.`;
      } else if (foul) {
        won = opponent.index;
        this.message = `${player.name} fouled while pocketing the 8-ball.`;
        this.detail = `${opponent.name} wins the game.`;
      } else {
        won = player.index;
        this.message = `${player.name} sinks the 8-ball and wins!`;
        this.detail = '';
      }
      this.breakDone = true;
      return this.finish(foul, foulReason, false, won, potted);
    }

    // ---- 5. group assignment on an open table ---------------------------
    if (!isBreak && this.openTable && !foul && objectPotted.length > 0) {
      const solids = objectPotted.filter((id) => groupOfBall(id) === SOLIDS).length;
      const stripes = objectPotted.filter((id) => groupOfBall(id) === STRIPES).length;
      if (solids > 0 && stripes === 0) this.assignGroups(SOLIDS);
      else if (stripes > 0 && solids === 0) this.assignGroups(STRIPES);
      else if (solids !== stripes) this.assignGroups(solids > stripes ? SOLIDS : STRIPES);
      // equal counts -> table stays open
    }

    // ---- 6. does the shooter keep the table? ----------------------------
    if (!foul) {
      const myGroup = player.group;
      if (this.openTable || !myGroup) {
        continueTurn = objectPotted.length > 0;
      } else {
        continueTurn = objectPotted.some((id) => groupOfBall(id) === myGroup);
      }
    }

    this.breakDone = true;
    this.applyFoulOrPass(foul, continueTurn, cuePotted, isBreak);

    // Build the message for the HUD.
    if (foul) {
      this.message = `Foul: ${foulReason}.`;
      this.detail = `${this.currentPlayer.name} has ball in hand.`;
    } else if (continueTurn) {
      this.message = objectPotted.length
        ? `${player.name} pockets ${describeBalls(objectPotted)}.`
        : `${player.name} continues.`;
      this.detail = 'Shooting again.';
    } else if (objectPotted.length) {
      this.message = `${player.name} pockets ${describeBalls(objectPotted)} — but it is not enough.`;
      this.detail = `${this.currentPlayer.name} is up.`;
    } else {
      this.message = `No pot for ${player.name}.`;
      this.detail = `${this.currentPlayer.name} is up.`;
    }

    return this.finish(foul, foulReason, continueTurn, null, potted);
  }

  /** Apply the consequence of a foul, then switch the shooter if needed. */
  applyFoulOrPass(foul, continueTurn, cuePotted, isBreak) {
    if (foul) {
      this.turn = 1 - this.turn;
      this.ballInHand = true;
      this.ballInHandKitchen = isBreak && cuePotted;
      const cue = this.world.cue;
      if (cuePotted) {
        // park the cue ball on the head spot until the player moves it
        const headX = -FOOT_SPOT.x;
        const spot = isValidCuePosition(this.world.balls, headX, 0)
          ? { x: headX, z: 0 }
          : this.findFreeSpot(headX, 0);
        this.world.placeCueBall(spot.x, spot.z);
      }
    } else {
      this.ballInHand = false;
      this.ballInHandKitchen = false;
      if (!continueTurn) this.turn = 1 - this.turn;
    }
    this.turnCount++;
  }

  finish(foul, foulReason, continueTurn, winner, potted) {
    if (winner !== null && winner !== undefined) {
      this.gameOver = true;
      this.winner = winner;
      this.continueTurn = false;
    }
    this.lastShot = {
      foul,
      foulReason,
      continueTurn: !!continueTurn,
      potted,
      player: this.turn,
    };
    return this.lastShot;
  }

  assignGroups(group) {
    const other = group === SOLIDS ? STRIPES : SOLIDS;
    this.players[this.turn].group = group;
    this.players[1 - this.turn].group = other;
    this.openTable = false;
    this.message = `${this.players[this.turn].name} is on ${groupLabel(group).toLowerCase()}.`;
  }

  /** Put a pocketed ball back on (or as near as possible to) the foot spot. */
  respotBall(id) {
    const ball = this.world.ball(id);
    if (!ball) return;
    ball.active = true;
    ball.potted = false;
    ball.pocket = -1;
    ball.vx = ball.vy = ball.vz = 0;
    ball.wx = ball.wy = ball.wz = 0;
    ball.sinkT = 0;
    ball.sinkY = 0;
    let spot = { x: FOOT_SPOT.x, z: FOOT_SPOT.z };
    if (!isValidCuePosition(this.world.balls, spot.x, spot.z, id)) {
      spot = this.findFreeSpot(spot.x, spot.z, id);
    }
    ball.x = spot.x;
    ball.z = spot.z;
    ball.y = BALL_RADIUS;
  }

  /** Search for the nearest free spot (walking toward the foot rail). */
  findFreeSpot(x, z, ignoreId = -1) {
    for (let d = 0; d < 1.4; d += BALL_RADIUS) {
      for (const sx of [1, -1]) {
        const px = x + d * sx;
        if (Math.abs(px) > HALF_L - BALL_RADIUS * 2) continue;
        for (const sz of [0, 1, -1]) {
          const pz = z + d * 0.35 * sz;
          if (Math.abs(pz) > HALF_W - BALL_RADIUS * 2) continue;
          if (isValidCuePosition(this.world.balls, px, pz, ignoreId) && !pocketAt(px, pz)) {
            return { x: px, z: pz };
          }
        }
      }
    }
    return { x: FOOT_SPOT.x, z: FOOT_SPOT.z };
  }

  /** Can the cue ball be dropped here right now? */
  canPlaceCue(x, z) {
    if (!isValidCuePosition(this.world.balls, x, z, 0)) return false;
    if (this.ballInHandKitchen && x > -FOOT_SPOT.x) return false; // behind head string
    return true;
  }

  remainingFor(group) {
    return this.world.balls.filter((b) => b.active && groupOfBall(b.id) === group).length;
  }

  reset(world) {
    this.world = world;
    for (const p of this.players) p.group = null;
    this.turn = 0;
    this.openTable = true;
    this.ballInHand = false;
    this.ballInHandKitchen = false;
    this.breakDone = false;
    this.gameOver = false;
    this.winner = null;
    this.message = 'Break to start.';
    this.detail = '';
    this.lastShot = null;
    this.turnCount = 1;
  }
}

function describeBalls(ids) {
  const names = ids.map((id) => (id === 0 ? 'the cue ball' : id === 8 ? 'the 8' : `${id}`));
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
