// Latin subsets only: the full font sets add ~0.5 MB to the bundle.
import '@fontsource/patrick-hand/latin-400.css';
import '@fontsource/patrick-hand/latin-ext-400.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/caveat/latin-ext-700.css';
import 'katex/dist/katex.min.css';
import './styles.css';

export { createOverlay, Overlay } from './overlay';
export type { OverlayOptions } from './overlay';
export { ProxyClient, SpeechQueue } from './client';
export type { AskEvent, AskRequest, Beat, Book, BookPart, BookSummary, Genre, Health, SessionLine, SessionResult, TourEvent, Turn } from './client';
export { colorOf } from './theme';
export { compile, compileEquation } from './expr';
export { setRichText } from './math';
export type * from './types';
