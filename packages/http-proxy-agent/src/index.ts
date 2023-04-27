import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import createDebug from 'debug';
import once from '@tootallnate/once';
import { Agent, AgentConnectOpts } from 'agent-base';

const debug = createDebug('http-proxy-agent');

interface HttpProxyAgentClientRequest extends http.ClientRequest {
	outputData?: {
		data: string;
	}[];
	_header?: string | null;
	_implicitHeader(): void;
}

function isHTTPS(protocol?: string | null): boolean {
	return typeof protocol === 'string' ? /^https:?$/i.test(protocol) : false;
}

/**
 * The `HttpProxyAgent` implements an HTTP Agent subclass that connects
 * to the specified "HTTP proxy server" in order to proxy HTTP requests.
 */
export class HttpProxyAgent extends Agent {
	readonly proxy: URL;
	connectOpts: net.TcpNetConnectOpts & tls.ConnectionOptions;

	get secureProxy() {
		return isHTTPS(this.proxy.protocol);
	}

	constructor(
		proxy: string | URL,
		opts?: net.TcpNetConnectOpts & tls.ConnectionOptions
	) {
		super();
		this.proxy = typeof proxy === 'string' ? new URL(proxy) : proxy;
		debug('Creating new HttpProxyAgent instance: %o', this.proxy);

		const host = this.proxy.hostname || this.proxy.host;
		const port = this.proxy.port
			? parseInt(this.proxy.port, 10)
			: this.secureProxy
			? 443
			: 80;
		this.connectOpts = {
			...opts,
			host,
			port,
		};
	}

	async connect(
		req: HttpProxyAgentClientRequest,
		opts: AgentConnectOpts
	): Promise<net.Socket> {
		const { proxy } = this;

		const protocol = opts.secureEndpoint ? 'https:' : 'http:';
		const hostname = opts.host || req.getHeader('host') || 'localhost';
		const base = `${protocol}//${hostname}:${opts.port}`;
		const url = new URL(req.path, base);

		// Change the `http.ClientRequest` instance's "path" field
		// to the absolute path of the URL that will be requested.
		req.path = String(url);

		// Inject the `Proxy-Authorization` header if necessary.
		req._header = null;
		if (proxy.username || proxy.password) {
			const auth = `${proxy.username}:${proxy.password}`;
			req.setHeader(
				'Proxy-Authorization',
				`Basic ${Buffer.from(auth).toString('base64')}`
			);
		}

		// Create a socket connection to the proxy server.
		let socket: net.Socket;
		if (this.secureProxy) {
			debug('Creating `tls.Socket`: %o', proxy);
			socket = tls.connect(this.connectOpts);
		} else {
			debug('Creating `net.Socket`: %o', proxy);
			socket = net.connect(this.connectOpts);
		}

		// At this point, the http ClientRequest's internal `_header` field
		// might have already been set. If this is the case then we'll need
		// to re-generate the string since we just changed the `req.path`.
		let first: string;
		let endOfHeaders: number;
		debug('Regenerating stored HTTP header string for request');
		req._implicitHeader();
		if (req.outputData && req.outputData.length > 0) {
			// Node >= 12
			debug(
				'Patching connection write() output buffer with updated header'
			);
			first = req.outputData[0].data;
			endOfHeaders = first.indexOf('\r\n\r\n') + 4;
			req.outputData[0].data =
				req._header + first.substring(endOfHeaders);
			debug('Output buffer: %o', req.outputData[0].data);
		}

		// Wait for the socket's `connect` event, so that this `callback()`
		// function throws instead of the `http` request machinery. This is
		// important for i.e. `PacProxyAgent` which determines a failed proxy
		// connection via the `callback()` function throwing.
		await once(socket, 'connect');

		return socket;
	}
}