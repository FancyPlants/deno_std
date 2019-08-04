// Copyright 2018-2019 the Deno authors. All rights reserved. MIT license.
const { listen } = Deno;
import { TextProtoReader } from 'https://deno.land/std/textproto/mod.ts';
import { BufReader } from 'https://deno.land/std/io/bufio.ts';
import { encode } from 'https://deno.land/std/strings/mod.ts';
// import { WebSocket, OpCode } from 'https://deno.land/std/ws/mod.ts';

/** Represents some underlying connection, so we can use Websockets too. */
export interface MessageSource {
  close(): void;
  write(msg: string | Uint8Array): Promise<void>;
  messages(): AsyncIterableIterator<string>;
}

class TcpSource implements MessageSource {
  private _conn: Deno.Conn;
  private _reader: TextProtoReader;

  public constructor(conn: Deno.Conn) {
    this._conn = conn;
    this._reader = new TextProtoReader(new BufReader(conn));
  }

  public close(): void {
    this._conn.close();
  }

  public async write(msg: string | Uint8Array): Promise<void> {
    let encoded: Uint8Array;
    if (typeof msg === 'string') {
      encoded = encode(msg);
    } else {
      encoded = msg;
    }

    await this._conn.write(encoded);
  }

  public async *messages(): AsyncIterableIterator<string> {
    while (true) {
      try {
        const plaintext = await this._reader.readLine();
        if (plaintext) {
          yield plaintext;
        }
      } catch (err) {
        if (err === 'EOF') {
          return;
        }
      }
    }
  }
}

// NOTE: Class commented out due to non usage.
// class WebSocketSource implements MessageSource {
//   private _ws: WebSocket;

//   public constructor(ws: WebSocket) {
//     this._ws = ws;
//   }

//   public close(): void {
//     this._ws.close(OpCode.Close);
//   }

//   public write(msg: string | Uint8Array): Promise<void> {
//     return this._ws.send(msg);
//   }

//   public async *messages(): AsyncIterableIterator<string> {
//     for await (const event of this._ws.receive()) {
//       if (typeof event === 'string') {
//         yield event;
//       } else if (event instanceof Uint8Array) {
//         yield decode(event);
//       }
//     }
//   }
// }

// ensures that there are no crashes if a wrong
// property on a MessageData object, as a try-catch
// block does not catch
const messageProxyHandler = {
  get(target: MessageData, property: string): ProxyHandler<MessageData> {
    if (target[property] === undefined) {
      throw new TypeError(`Property ${String(property)} does not exist on Message.`);
    }

    return target[property];
  },
};

enum RPL {
  WELCOME = '001',
  YOURHOST = '002',
  CREATED = '003',
  MYINFO = '004',
  ISUPPORT = '005',
  LUSERCLIENT = '251',
  LUSEROP = '252',
  LUSERUNKNOWN = '253',
  LUSERCHANNELS = '254',
  LUSERME = '255',
  LOCALUSERS = '265',
  GLOBALUSERS = '266',
  ENDOFWHO = '315',
  CHANNELMODEIS = '324',
  NOTOPIC = '331',
  TOPIC = '332',
  WHOREPLY = '352',
  NAMREPLY = '353',
  ENDOFNAMES = '366',
}

enum ERR {
  NOSUCHNICK = '401',
  NOSUCHSERVER = '402',
  NOSUCHCHANNEL = '403',
  UNKNOWNCOMMAND = '421',
  NOMOTD = '422',
  NONICKNAMEGIVEN = '431',
  ERRONEUSNICKNAME = '432',
  NICKNAMEINUSE = '433',
  NOTONCHANNEL = '442',
  NEEDMOREPARAMS = '461',
  ALREADYREGISTERED = '462',
  BANNEDFROMCHAN = '474',
}

export class IrcServer {
  private _listener: Deno.Listener;
  private _channels: Map<string, Channel> = new Map();
  /** Maps nicknames to user objects */
  private _conns: Map<string, ServerConn> = new Map();
  private _host: string;

  public constructor(address: string) {
    this._listener = listen('tcp', address);

    // Host prefixes for replies don't have the port usually
    this._host = address.substring(0, address.indexOf(':'));
  }

  /** Allows server to begin accepting connections and messages */
  public async start(): Promise<void> {
    while (true) {
      let conn: Deno.Conn;
      try {
        conn = await this._listener.accept();
      } catch (e) {
        console.error(e.toString());
        break;
      }

      const newServerConn = new ServerConn(new TcpSource(conn));
      const id = conn.rid.toString();
      this._conns.set(id, newServerConn);
      newServerConn.id = id;
      this._handleUserMessages(newServerConn);
    }
  }

  // start() {
  //   const acceptRoutine = () => {
  //     const handleConn = (conn: Conn) => {
  //       const newServerConn = new ServerConn(conn);
  //       // TODO(fancyplants) replace id with conn.rid when implemented
  //       const id = generateID();
  //       this._conns.set(id, newServerConn);
  //       newServerConn.id = id;
  //       this._handleUserMessages(newServerConn);
  //       scheduleAccept();
  //     };

  //     const scheduleAccept = () => {
  //       this._listener.accept().then(handleConn);
  //     };

  //     scheduleAccept();
  //   };

  //   acceptRoutine();
  // }

  private async _handleUserMessages(conn: ServerConn): Promise<void> {
    for await (const msg of conn.readMessages()) {
      try {
        const parsedMsg = new Proxy(parse(msg), messageProxyHandler);

        switch (parsedMsg.command) {
          case 'NICK':
            const nickname = parsedMsg.params[0];
            // TODO make sure nickname is sound
            this.NICK(conn, nickname);
            break;

          case 'USER':
            const username = parsedMsg.params[0];
            const fullname = parsedMsg.params[3];
            this.USER(conn, username, fullname);
            break;

          case 'JOIN':
            const channels = parseCSV(parsedMsg.params[0]);
            const keys = parseCSV(parsedMsg.params[1]);
            this.JOIN(conn, channels, keys);
            break;

          case 'PART':
            const partChannels = parseCSV(parsedMsg.params[0]);
            this.PART(conn, partChannels, parsedMsg.params[1]);
            break;

          case 'PRIVMSG':
            const targets = parseCSV(parsedMsg.params[0]);
            this.PRIVMSG(conn, targets, parsedMsg.params[1]);
            break;

          case 'NAMES':
            const nameChannels = parseCSV(parsedMsg.params[0]);
            this.NAMES(conn, nameChannels);
            break;

          case 'WHO':
            const channelName = parsedMsg.params[0];
            this.WHO(conn, channelName);
            break;

          case 'QUIT':
            const reason = parsedMsg.params[0];
            this.QUIT(conn, reason);
            break;

          case 'MODE':
            const target = parsedMsg.params[0];
            this.MODE(conn, target);
            break;

          case 'PING':
            this.PING(conn);
            break;

          default:
            this._replyToConn(conn, ERR.UNKNOWNCOMMAND, [parsedMsg.command, ':Unknown/unimplemented command']);
            break;
        }
      } catch (err) {
        console.error(err);
      }
    }

    this.QUIT(conn);
  }

  public close(): void {
    this._listener.close();
    for (const [, conn] of this._conns) {
      conn.close();
    }
  }

  private _sendMsg(conn: ServerConn, prefix: string, command: string, params: string[]): void {
    return conn.write(`:${prefix} ${command} ${params.join(' ')}\r\n`);
  }

  private _replyToConn(conn: ServerConn, command: string, params: string[]): void {
    // for unregistered users, most servers just put an asterisk in the <client> spot
    const nickname = conn.nickname || '*';
    let n = conn.write(`:${this._host} ${command} ${nickname} ${params.join(' ')}\r\n`);

    return n;
  }

  private _attemptRegisterConn(conn: ServerConn): void {
    if (!conn.nickname || !conn.username || !conn.fullname) {
      // can only register with all three
      return;
    }

    this._conns.set(conn.nickname, conn);
    conn.isRegistered = true;

    if (this._conns.has(conn.id)) {
      this._conns.delete(conn.id);
    }

    // after successful registration, multiple mandated responses from server
    this._replyToConn(conn, RPL.WELCOME, [`:Welcome to the server ${conn.nickname}`]);
    this._replyToConn(conn, RPL.YOURHOST, [':Your host is PLACEHOLDER, running version PLACEHOLDER']);
    this._replyToConn(conn, RPL.CREATED, [':This server was created PLACEHOLDER']);
    this._replyToConn(conn, RPL.MYINFO, ['Misc information here']);
    this._replyToConn(conn, RPL.ISUPPORT, ['PLACEHOLDER :are supported by this server.']);
    this._replyToLUSERS(conn);
    this._sendMOTD(conn);
  }

  private _sendMOTD(conn: ServerConn): void {
    // TODO(fancyplants) send actual MOTD message
    this._replyToConn(conn, ERR.NOMOTD, [':MOTD is missing']);
  }

  private _replyToLUSERS(conn: ServerConn): void {
    this._replyToConn(conn, RPL.LUSERCLIENT, [':There are PLACEHOLDER users and PLACEHOLDER invisible on 1 server']);
    this._replyToConn(conn, RPL.LUSEROP, [':PLACEHOLDER :operators online']);
    this._replyToConn(conn, RPL.LUSERUNKNOWN, ['PLACEHOLDER :unknown connections']);
    this._replyToConn(conn, RPL.LUSERCHANNELS, [`${this._channels.size} :channels formed`]);
    this._replyToConn(conn, RPL.LUSERME, [':I have PLACEHOLDER clients and 1 server']);
  }

  private _replyToNAMES(conn: ServerConn, channels: string[]): void {
    for (const channelName of channels) {
      const channel = this._channels.get(channelName);
      if (!channel) {
        continue;
      }

      const channelOps = channel.ops;
      const userNicks = channel.users.map((user): string =>
        channelOps.includes(user) ? `@${user.nickname}` : user.nickname,
      );

      for (const nick of userNicks) {
        this._replyToConn(conn, RPL.NAMREPLY, ['=', channel.name, `:${nick}`]);
      }

      this._replyToConn(conn, RPL.ENDOFNAMES, [channel.name, ':End of /NAMES list']);
    }
  }

  // NOTE: Method commented out due to non usage.
  // private _replyToTOPIC(conn: ServerConn, channelName: string): void {
  //   // TODO(fancyplants) implement channel topics
  //   this._replyToConn(conn, RPL.NOTOPIC, [':No topic is set (TODO)']);
  // }

  public NICK(conn: ServerConn, nickname: string): void {
    if (!nickname) {
      this._replyToConn(conn, ERR.NONICKNAMEGIVEN, [':No nickname given']);
      return;
    }

    // check if any registered users got that nickname
    for (const [, currConn] of this._conns) {
      if (currConn.nickname === nickname) {
        this._replyToConn(conn, ERR.NICKNAMEINUSE, [`:Nickname "${nickname}" has already been taken.`]);
        return;
      }
    }

    if (conn.nickname) {
      // let other users know that a user changed their nickname
      const oldNickname = conn.nickname;
      conn.nickname = nickname;
      this._attemptRegisterConn(conn);
      const nicknameUpdateMsg = `:${oldNickname} NICK ${nickname}\r\n`;

      // maybe handle automatic updates to other user through Proxying User?
      for (const [, currConn] of this._conns) {
        if (conn === currConn) {
          continue;
        }

        currConn.write(nicknameUpdateMsg);
      }
    } else {
      conn.nickname = nickname;
      this._attemptRegisterConn(conn);
    }
  }

  public USER(conn: ServerConn, username: string, fullname: string): void {
    if (!username || !fullname) {
      this._replyToConn(conn, ERR.NEEDMOREPARAMS, [':Wrong params for USER command']);
      return;
    }

    if (conn.isRegistered) {
      this._replyToConn(conn, ERR.ALREADYREGISTERED, [':Cannot register twice']);
      return;
    }

    for (const [, currConn] of this._conns) {
      if (currConn.username === username) {
        this._replyToConn(conn, ERR.ALREADYREGISTERED, [':Cannot register twice']);
        return;
      }
    }

    conn.username = username;
    conn.fullname = fullname;
    this._attemptRegisterConn(conn);
  }

  public JOIN(conn: ServerConn, channels: string[], keys: string[]): void {
    if (channels.length === 0) {
      this._replyToConn(conn, ERR.NEEDMOREPARAMS, []);
      return;
    }

    for (let i = 0; i < channels.length; i++) {
      const channelName = channels[i];
      const key = keys[i];
      if (key) {
        throw new Error('Not ready for keys yet!');
      }

      if (!channelName.startsWith('#') && !channelName.startsWith('&')) {
        continue;
      }

      let channel = this._channels.get(channelName);
      if (!channel) {
        channel = new Channel(channelName);
        channel.topic = 'PLACEHOLDER';
        this._channels.set(channelName, channel);
      }
      try {
        channel.joinChannel(conn);
      } catch (e) {
        if (e instanceof ChannelBannedError) {
          this._replyToConn(conn, ERR.BANNEDFROMCHAN, [conn.username, channelName, ':Cannot join channel (+b)']);
        }

        // if joining failed, just try to join the next one
        continue;
      }

      this._replyToNAMES(conn, [channelName]);
      // this._replyToTOPIC(conn, channelName);
      // notify other users on channel that a new user has entered
      for (const userConn of channel.users) {
        this._sendMsg(userConn, conn.nickname, 'JOIN', [channelName]);
      }
    }
  }

  public PART(conn: ServerConn, channels: string[], reason?: string): void {
    // first check if user is actually within each channel
    for (const channelName of channels) {
      const isInChannel = conn.joinedChannels.has(channelName);
      if (!isInChannel) {
        this._replyToConn(conn, ERR.NOTONCHANNEL, [channelName, ":You're not on that channel"]);
        return;
      }
    }

    for (const channelName of channels) {
      const channel = conn.joinedChannels.get(channelName);
      // notify users in channel that this person has left
      if (channel) {
        reason = reason || '';
        for (const userConn of channel.users) {
          this._sendMsg(userConn, conn.nickname, 'PART', [channelName, reason]);
        }
        channel.leaveChannel(conn);
      }
    }
  }

  public PRIVMSG(conn: ServerConn, targets: string[], message: string): void {
    for (const target of targets) {
      // TODO(fancyplants) target other channel prefixes
      if (target.startsWith('#')) {
        const channel = this._channels.get(target);
        if (!channel) {
          this._replyToConn(conn, ERR.NOSUCHNICK, [':No such channel']);
        } else {
          for (const userConn of channel.users) {
            if (userConn === conn) {
              continue;
            }

            this._sendMsg(userConn, conn.nickname, 'PRIVMSG', [channel.name, message]);
          }
        }
      } else {
        const targetConn = this._conns.get(target);
        if (!targetConn) {
          this._replyToConn(conn, ERR.NOSUCHNICK, [':No such nick']);
          continue;
        }
        this._sendMsg(targetConn, conn.nickname, 'PRIVMSG', [targetConn.nickname, message]);
      }
    }
  }

  public NAMES(conn: ServerConn, channels: string[]): void {
    this._replyToNAMES(conn, channels);
  }

  public WHO(conn: ServerConn, channelName: string): void {
    const channel = this._channels.get(channelName);
    if (!channel) {
      this._replyToConn(conn, ERR.NOSUCHSERVER, [':No such server']);
      return;
    }
    for (const userConn of channel.users) {
      this._replyToConn(conn, RPL.WHOREPLY, [
        channelName,
        userConn.username,
        'PLACEHOLDER', // host of user
        this._host,
        userConn.nickname,
        'G',
        `:0 ${userConn.fullname}`,
      ]);
    }
    this._replyToConn(conn, RPL.ENDOFWHO, [channelName, ':End of /WHO list']);
  }

  public QUIT(conn: ServerConn, reason = 'User has exited server'): void {
    if (conn.nickname) {
      this._conns.delete(conn.nickname);
    }

    if (conn.id) {
      this._conns.delete(conn.id);
    }

    for (const [name, channel] of conn.joinedChannels) {
      channel.leaveChannel(conn);
      for (const userConn of channel.users) {
        this._sendMsg(userConn, conn.nickname, 'PART', [name]);
      }
    }
    for (const [, userConn] of this._conns) {
      this._sendMsg(userConn, conn.nickname, 'QUIT', [`:Quit: ${reason}`]);
    }
  }

  public MODE(conn: ServerConn, target: string): void {
    if (target.startsWith('#') || target.startsWith('&')) {
      const channel = this._channels.get(target);
      if (!channel) {
        this._replyToConn(conn, ERR.NOSUCHCHANNEL, [':No such channel']);
        return;
      }

      this._replyToConn(conn, RPL.CHANNELMODEIS, [target, `+c${channel.modes.join('')}`]);
    } else {
      // TODO
    }
  }

  public PING(conn: ServerConn): void {
    this._replyToConn(conn, 'PONG', []);
  }
}

/** Represents IRCv3 tags parsed as an object. */
export interface ParsedTags {
  [tag: string]: string | boolean;
}

/** MessageData is a parsed representation of a client message */
export interface MessageData {
  [key: string]: any;
  tags: ParsedTags;
  prefix: string;
  command: string;
  params: string[];
}

function parseCSV(input: string): string[] {
  return input ? input.split(',').filter((channel): boolean => channel !== '') : [];
}

const RFC1459MaxMessageLength = 512;

export function parse(message: string): MessageData {
  if (message.length > RFC1459MaxMessageLength) {
    throw new InvalidMessageException('Message cannot exceed 512 characters.');
  }

  if (message.endsWith('\r\n')) {
    throw new InvalidMessageException('CRLF must be removed from string before using parse.');
  }

  let tags: ParsedTags = {};
  let prefix = '';
  let command: string;
  let params: string[] = [];
  let index = 0;
  const messageParts = message.split(' ');

  // check for tags
  if (messageParts[index].startsWith('@')) {
    tags = parseTagsToJSON(messageParts[index]);
    index++;
  }

  // check for possible prefix
  if (messageParts[index].startsWith(':')) {
    prefix = messageParts[index];
    index++;
  }

  command = messageParts[index];
  index++;

  // iterate through params and add them one at a time,
  // possibly concatenating any message after another colon (":")
  // into one string as the last parameter
  for (let i = index; i < messageParts.length; i++) {
    const currentPart = messageParts[i];

    // any param that starts with a colon is the last param with whitespace
    // included
    if (currentPart.startsWith(':')) {
      const remainingParts = messageParts.slice(i);
      const lastParam = remainingParts.reduce((prev, curr): string => `${prev} ${curr}`);
      params.push(lastParam);
      break;
    }

    params.push(currentPart);
  }

  return {
    tags,
    prefix,
    command,
    params,
  };
}

function parseTagsToJSON(tags: string): ParsedTags {
  const parsedTags: ParsedTags = {};
  const strWithoutSymbol = tags.substring(1);
  const tagParts = strWithoutSymbol.split(';');

  for (const part of tagParts) {
    const [key, value] = part.split('=');
    if (value === '') {
      parsedTags[key] = '';
    } else if (!value) {
      parsedTags[key] = true;
    } else {
      parsedTags[key] = value;
    }
  }

  return parsedTags;
}

/** Indicates that there was an invalid message passed to `parse` */
export class InvalidMessageException extends Error {}

export enum UserMode {
  Invisible = '+i',
  Operator = '+o',
  LocalOperator = '+O',
  Registered = '+r',
  Wallops = '+w',
}

export class ServerConn {
  private _source: MessageSource;
  private _userModes: Set<UserMode> = new Set();

  public joinedChannels: Map<string, Channel> = new Map();
  public nickname = '';
  public username = '';
  public fullname = '';
  public isRegistered = false;
  public id = '';

  public constructor(source: MessageSource) {
    this._source = source;
  }

  public readMessages(): AsyncIterableIterator<string> {
    return this._source.messages();
  }

  /** Writes message to underlying BufWriter */
  public write(msg: string | Uint8Array): void {
    this._source.write(msg);
  }

  public close(): void {
    this._source.close();
  }

  public get modes(): UserMode[] {
    return Array.from(this._userModes);
  }

  public get isInvisible(): boolean {
    return this._userModes.has(UserMode.Invisible);
  }

  public set isInvisible(bool: boolean) {
    bool ? this._userModes.add(UserMode.Invisible) : this._userModes.delete(UserMode.Invisible);
  }

  public get isOp(): boolean {
    return this._userModes.has(UserMode.Operator);
  }

  public set isOp(bool: boolean) {
    bool ? this._userModes.add(UserMode.Operator) : this._userModes.delete(UserMode.Operator);
  }

  public get isLocalOp(): boolean {
    return this._userModes.has(UserMode.LocalOperator);
  }

  public set isLocalOp(bool: boolean) {
    bool ? this._userModes.add(UserMode.LocalOperator) : this._userModes.delete(UserMode.LocalOperator);
  }

  public get isWallops(): boolean {
    return this._userModes.has(UserMode.Wallops);
  }

  public set isWallops(bool: boolean) {
    bool ? this._userModes.add(UserMode.Wallops) : this._userModes.delete(UserMode.Wallops);
  }
}

export class ChannelBannedError extends Error {}

export enum ChannelMode {
  Ban = '+b',
  Exception = '+e',
  ClientLimit = '+l',
  InviteOnly = '+i',
  InviteException = '+I',
  Key = '+k',
  Moderated = '+m',
  Secret = '+s',
  ProtectedTopic = '+t',
  NoExternalMessages = '+n',
}

export class Channel {
  public name: string;
  public topic: string;

  // for now, bannedUsers will just be attached to username, as a user
  // cannot change that without disconnecting
  private _banMode: { enabled: boolean; bannedUsers: string[] };

  private _modes: Set<ChannelMode> = new Set();
  private _ops: Set<ServerConn> = new Set();
  private _users: Set<ServerConn> = new Set();

  public constructor(name: string) {
    this.name = name;
    this.topic = '';
    this._banMode = {
      enabled: false,
      bannedUsers: [],
    };
  }

  public joinChannel(conn: ServerConn): void {
    if (this._users.size === 0) {
      this._ops.add(conn);
    }

    if (this._banMode.enabled && this._banMode.bannedUsers.includes(conn.username)) {
      throw new ChannelBannedError();
    }

    this._users.add(conn);
    conn.joinedChannels.set(this.name, this);
    return;
  }

  public leaveChannel(conn: ServerConn): void {
    this._users.delete(conn);
    conn.joinedChannels.delete(this.name);
    if (this._users.size === 0) {
      this._ops.delete(conn);
    }
  }

  public get users(): ServerConn[] {
    return Array.from(this._users);
  }

  public get ops(): ServerConn[] {
    return Array.from(this._ops);
  }

  public get modes(): ChannelMode[] {
    return Array.from(this._modes);
  }

  public set banMode(bool: boolean) {
    this._banMode.enabled = bool;
  }

  public get banMode(): boolean {
    return this._banMode.enabled;
  }
}
