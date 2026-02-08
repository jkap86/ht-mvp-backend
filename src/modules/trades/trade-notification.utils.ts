import { TradeWithDetails, TradeItemWithPlayer, LeagueChatMode } from './trades.model';

export interface TradeNotificationText {
  summary: string;
  details: string;
}

/**
 * Format trade for notifications (league chat and DM).
 * Returns both a summary line and detailed breakdown.
 */
export function formatTradeForNotifications(trade: TradeWithDetails): TradeNotificationText {
  const summary = `${trade.proposerTeamName} proposed a trade to ${trade.recipientTeamName}`;

  const proposerGives = trade.items.filter((i) => i.fromRosterId === trade.proposerRosterId);
  const recipientGives = trade.items.filter((i) => i.fromRosterId === trade.recipientRosterId);

  const lines: string[] = [];

  lines.push(`${trade.proposerTeamName} gives:`);
  for (const item of proposerGives) {
    lines.push(`  - ${formatTradeItem(item)}`);
  }

  lines.push('');
  lines.push(`${trade.recipientTeamName} gives:`);
  for (const item of recipientGives) {
    lines.push(`  - ${formatTradeItem(item)}`);
  }

  if (trade.message) {
    lines.push('');
    lines.push(`Note: ${trade.message}`);
  }

  return { summary, details: lines.join('\n') };
}

/**
 * Format a single trade item (player or draft pick) for display.
 */
function formatTradeItem(item: TradeItemWithPlayer): string {
  if (item.itemType === 'player') {
    const posTeam = [item.position, item.team].filter(Boolean).join(' - ');
    return item.fullName + (posTeam ? ` (${posTeam})` : '');
  } else {
    // Draft pick
    const round = getOrdinalSuffix(item.pickRound ?? 0);
    return `${item.pickSeason} ${round} (${item.pickOriginalTeam})`;
  }
}

/**
 * Get ordinal suffix for a number (1st, 2nd, 3rd, 4th, etc.)
 */
function getOrdinalSuffix(n: number): string {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

/**
 * Clamp user's requested league chat mode to commissioner's max.
 * Ordering: none < summary < details
 */
export function clampLeagueChatMode(
  requested: LeagueChatMode,
  max: LeagueChatMode
): LeagueChatMode {
  const order: LeagueChatMode[] = ['none', 'summary', 'details'];
  const requestedIndex = order.indexOf(requested);
  const maxIndex = order.indexOf(max);
  return order[Math.min(requestedIndex, maxIndex)];
}

/**
 * Get effective league chat mode considering:
 * - User's requested mode (takes precedence if provided)
 * - Backward compat with notify_league_chat boolean
 * - Commissioner's max setting (clamps the result)
 * - Commissioner's default setting (used if no user preference)
 */
export function getEffectiveLeagueChatMode(
  userMode: LeagueChatMode | undefined,
  userNotifyLeagueChat: boolean | undefined,
  commissionerMax: LeagueChatMode = 'details',
  commissionerDefault: LeagueChatMode = 'summary'
): LeagueChatMode {
  let requested: LeagueChatMode;

  if (userMode !== undefined) {
    // New mode takes precedence
    requested = userMode;
  } else if (userNotifyLeagueChat !== undefined) {
    // Backward compatibility: boolean maps to 'summary' or 'none'
    requested = userNotifyLeagueChat ? 'summary' : 'none';
  } else {
    // Use commissioner's default
    requested = commissionerDefault;
  }

  // Clamp to commissioner's max
  return clampLeagueChatMode(requested, commissionerMax);
}
