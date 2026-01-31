export interface Conversation {
  id: number;
  user1Id: string;
  user2Id: string;
  user1LastReadMessageId: number | null;
  user2LastReadMessageId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationWithDetails {
  id: number;
  otherUserId: string;
  otherUsername: string;
  lastMessage: DirectMessageWithUser | null;
  unreadCount: number;
  updatedAt: Date;
}

export interface DirectMessage {
  id: number;
  conversationId: number;
  senderId: string;
  message: string;
  createdAt: Date;
}

export interface DirectMessageWithUser extends DirectMessage {
  senderUsername: string;
}

export function conversationToResponse(conv: ConversationWithDetails): any {
  return {
    id: conv.id,
    other_user_id: conv.otherUserId,
    other_username: conv.otherUsername,
    last_message: conv.lastMessage ? messageToResponse(conv.lastMessage) : null,
    unread_count: conv.unreadCount,
    updated_at: conv.updatedAt,
  };
}

export function messageToResponse(msg: DirectMessageWithUser): any {
  return {
    id: msg.id,
    conversation_id: msg.conversationId,
    sender_id: msg.senderId,
    sender_username: msg.senderUsername,
    message: msg.message,
    created_at: msg.createdAt,
  };
}
