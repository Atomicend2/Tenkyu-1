import type { WASocket, proto } from "@whiskeysockets/baileys";

export interface CommandContext {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  from: string;
  sender: string;
  command: string;
  args: string[];
  isAdmin: boolean;
  isBotAdmin: boolean;
  isOwner: boolean;
  isGroupAdmin: boolean;
  groupMeta: any;
  prefix: string;
  body: string;
  /**
   * All @mentioned JIDs from the message, pre-resolved from @lid to
   * @s.whatsapp.net using the group participant list. Use resolvedMentions[0]
   * instead of msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
   * in every command so @lid mentions work correctly.
   */
  resolvedMentions: string[];
}
