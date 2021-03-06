/**
 * rpc消息中转服务器
 */

import Application from "../application";
import tcpServer from "./tcpServer";
import { SocketProxy, loggerType, componentName, rpcErr, rpcMsg } from "../util/interfaceDefine";
import define = require("../util/define");

let app: Application;
let servers: { [id: string]: rpc_server_proxy } = {};

export function start(_app: Application, cb: Function) {
    app = _app;
    tcpServer(app.port, startCb, newClientCb);

    function startCb() {
        console.log("server start: " + app.host + ":" + app.port + " / " + app.serverId);
        cb && cb();
    }
    function newClientCb(socket: SocketProxy) {
        new rpc_server_proxy(socket);
    }
}


class rpc_server_proxy {
    private socket: SocketProxy;
    private sid: string = "";
    private heartbeat_timer: NodeJS.Timer = null as any;
    private registered: boolean = false;
    private register_timer: NodeJS.Timer;
    constructor(socket: SocketProxy) {
        this.socket = socket;
        socket.on("data", this.onData.bind(this));
        socket.on("close", this.onClose.bind(this));

        this.register_timer = setTimeout(function () {
            app.logger(loggerType.warn, componentName.rpcServer, "register time out, close it");
            socket.close();
        }, 10000);

        this.heartBeat_handle();
    }


    /**
     * 发送消息
     * @param buf
     */
    send(buf: Buffer) {
        this.socket.send(buf);
    }

    /**
     * socket收到数据了
     * @param data
     */
    private onData(data: Buffer) {
        let type = data.readUInt8(0);
        if (type === define.Rpc_Msg.msg) {
            this.msg_handle(data);
        } else if (type === define.Rpc_Msg.register) {
            this.register_handle(data);
        } else if (type === define.Rpc_Msg.heartbeat) {
            this.heartBeat_handle();
        } else {
            app.logger(loggerType.debug, componentName.rpcServer, "illegal data, close rpc client named " + this.sid);
            this.socket.close();
        }
    }

    /**
     * socket连接关闭了
     */
    private onClose() {
        clearTimeout(this.register_timer);
        clearTimeout(this.heartbeat_timer);
        if (this.registered) {
            delete servers[this.sid];
        }
    }

    /**
     * 注册
     * @param data
     */
    private register_handle(_data: Buffer) {
        let data: any;
        try {
            data = JSON.parse(_data.slice(1).toString());
        } catch (err) {
            app.logger(loggerType.debug, componentName.rpcServer, "JSON parse error，close it");
            this.socket.close();
            return;
        }

        if (data.serverToken !== app.serverToken) {
            app.logger(loggerType.debug, componentName.rpcServer, "illegal token, it");
            this.socket.close();
            return;
        }
        if (!!servers[data.sid]) {
            this.socket.close();
            return;
        }
        clearTimeout(this.register_timer);
        this.registered = true;
        this.sid = data.sid;
        servers[this.sid] = this;
        app.logger(loggerType.info, componentName.rpcServer, "get new rpc client named  " + this.sid);
    }

    /**
     * 心跳
     */
    private heartBeat_handle() {
        let self = this;
        clearTimeout(this.heartbeat_timer);
        this.heartbeat_timer = setTimeout(function () {
            app.logger(loggerType.debug, componentName.rpcServer, " heartBeat time out : " + self.sid);
            self.socket.close();
        }, define.some_config.Time.Rpc_Heart_Beat_Time * 1000 * 2);
    }

    /**
     * 中转rpc消息
     * @param msgBuf
     */
    private msg_handle(msgBuf: Buffer) {
        if (!this.registered) {
            return;
        }
        let iMsgLen = msgBuf.readUInt8(5);
        let iMsg: rpcMsg = JSON.parse(msgBuf.slice(6, 6 + iMsgLen).toString());
        let server = servers[iMsg.to];
        if (server) {
            server.send(msgBuf.slice(1));
        } else if (iMsg.id && iMsg.from) {
            let iMsgBuf = Buffer.from(JSON.stringify({
                "id": iMsg.id
            }));
            let msgBuf2 = Buffer.from(JSON.stringify([rpcErr.rpc_has_no_end]));
            let buffer = Buffer.allocUnsafe(5 + iMsgBuf.length + msgBuf2.length);
            buffer.writeUInt32BE(iMsgBuf.length + msgBuf2.length + 1, 0);
            buffer.writeUInt8(iMsgBuf.length, 4);
            iMsgBuf.copy(buffer, 5);
            msgBuf2.copy(buffer, 5 + iMsgBuf.length);
            this.send(buffer);
        }
    }

    public close() {
        this.socket.close();
    }
}