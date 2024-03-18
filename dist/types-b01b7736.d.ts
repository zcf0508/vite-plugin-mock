import { IncomingMessage, ServerResponse } from 'http';

interface ViteMockOptions {
    mockPath?: string;
    configPath?: string;
    ignore?: RegExp | ((fileName: string) => boolean);
    watchFiles?: boolean;
    enable?: boolean;
    logger?: boolean;
    cors?: boolean;
}
interface RespThisType {
    req: IncomingMessage;
    res: ServerResponse;
    parseJson: () => any;
}
type MethodType = 'get' | 'post' | 'put' | 'delete' | 'patch';
type Recordable<T = any> = Record<string, T>;
declare interface MockMethod {
    url: string;
    method?: MethodType;
    timeout?: number;
    statusCode?: number;
    response?: ((this: RespThisType, opt: {
        url: Recordable;
        body: Recordable;
        query: Recordable;
        headers: Recordable;
    }) => any) | any;
    rawResponse?: (this: RespThisType, req: IncomingMessage, res: ServerResponse) => void;
}
interface MockConfig {
    env: Record<string, any>;
    mode: string;
    command: 'build' | 'serve';
}

export { MethodType as M, RespThisType as R, ViteMockOptions as V, Recordable as a, MockMethod as b, MockConfig as c };
