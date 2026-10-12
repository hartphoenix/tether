export interface CollectionHost {
  update(key: string, input: HTMLTextAreaElement, panel: HTMLElement, label: string, visible: boolean): void;
  remove(key: string): void;
  dispose(): void;
}
