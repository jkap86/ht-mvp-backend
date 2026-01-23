export interface ChatMessage {
  id: number;
  leagueId: number;
  userId: string;
  message: string;
  createdAt: Date;
}

export interface ChatMessageWithUser extends ChatMessage {
  username: string;
}

export function messageToResponse(msg: ChatMessageWithUser): any {
  return {
    id: msg.id,
    league_id: msg.leagueId,
    user_id: msg.userId,
    username: msg.username,
    message: msg.message,
    created_at: msg.createdAt,
  };
}
