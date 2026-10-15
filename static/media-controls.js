'use strict';

const MediaControls = (() => {
  function connect(audio, controls, environment = globalThis) {
    const session = environment.navigator?.mediaSession;
    if (!session) return { metadata() {}, state() {}, position() {}, clear() {} };
    function position() {
      if (!session.setPositionState) return;
      try {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) session.setPositionState();
        else session.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1,
          position: Math.max(0, Math.min(audio.currentTime || 0, audio.duration)) });
      } catch {} // Older webviews may expose only part of the API.
    }
    function seek(time) {
      if (Number.isFinite(audio.duration) && audio.duration > 0 && Number.isFinite(time)) {
        audio.currentTime = Math.max(0, Math.min(time, audio.duration)); position();
      }
    }
    const handlers = {
      play: controls.play, pause: controls.pause, stop: controls.stop,
      previoustrack: controls.previous, nexttrack: controls.next,
      seekbackward: data => seek(audio.currentTime - (data.seekOffset || 10)),
      seekforward: data => seek(audio.currentTime + (data.seekOffset || 10)),
      seekto: data => seek(data.seekTime)
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { session.setActionHandler(action, handler); } catch {}
    }
    return {
      metadata(track, artwork) {
        try {
          session.metadata = environment.MediaMetadata ? new environment.MediaMetadata({
            title: track.song_name || '', artist: track.singers || '', album: track.album || '',
            artwork: artwork ? [{ src: artwork }] : []
          }) : null;
          session.setPositionState?.();
        } catch {}
      },
      state(playing) { try { session.playbackState = playing ? 'playing' : 'paused'; } catch {} },
      position,
      clear() {
        try { session.metadata = null; session.playbackState = 'none'; session.setPositionState?.(); } catch {}
      }
    };
  }
  return { connect };
})();
