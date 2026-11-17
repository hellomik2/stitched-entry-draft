/**
 * Screen titles in one place. The product has no name yet: when it gets one, set APP_NAME
 * here and the page heading and the browser tab title follow.
 */
export const APP_NAME: string = ''

/** What the screen does, in one line. Shown as the page heading. */
export const BOARD_TITLE = 'CBP Form 7501 draft, stitched from your shipping documents'

/** Browser tab title: the name in front when there is one. */
export const PAGE_TITLE = APP_NAME ? `${APP_NAME}: ${BOARD_TITLE}` : BOARD_TITLE
