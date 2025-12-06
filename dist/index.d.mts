interface Config {
    webId: string;
    endpoint?: string;
}
declare class SenzorWebAgent {
    private config;
    private startTime;
    private endpoint;
    constructor();
    init(config: Config): void;
    private initSession;
    private getIds;
    private trackPageView;
    private trackPing;
    private send;
    private fallbackSend;
    private setupListeners;
}
declare const Senzor: SenzorWebAgent;

export { Senzor };
