export abstract class Database {
    protected instance: unknown = null;

    abstract init(): void;

    get db() {
        return this.instance
    }
}
