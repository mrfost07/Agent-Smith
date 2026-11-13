import { OverlayManager, OverlayState } from './overlay';

export class ElementAnnotator {
  static showGlowingBorder(state: OverlayState = 'acting', statusText?: string): void {
    OverlayManager.setState(state, statusText);
  }

  static hideGlowingBorder(): void {
    OverlayManager.setCaptureHidden(true);
  }

  static moveVisualCursorTo(x: number, y: number): void {
    OverlayManager.moveCursorTo(x, y);
  }

  static playClickAnimation(x: number, y: number): void {
    OverlayManager.playClickAnimation(x, y);
  }

  static removeVisualCursor(): void {
    OverlayManager.hide();
  }
}
