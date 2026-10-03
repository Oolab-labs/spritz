(function (root) {
  'use strict';

  /* What the app tells the person about each way of playing: who changes the audio language and the
   * subtitles (this Mac or the TV), what a change costs, and what a torrent that is still downloading cannot
   * do. Pure (no DOM): the renderer sets every string with textContent, and the wording is unit-tested.
   *
   * The routes really do differ. DLNA hands the TV the original file and the TV's own player owns the track
   * menus. Google Cast has the Mac convert the film, so a change rebuilds the stream. AirPlay and Spritz
   * Receiver switch in place. Saying so in the menu is the difference between "this film has no other
   * tracks" and "use the remote". */

  var TORRENT = 'While a torrent is downloading, seeking and subtitles only reach what has arrived.';

  function trackNotes(input) {
    var engine = input && input.engine, torrent = !!(input && input.torrent);
    var none = { audio: null, subs: null };
    if (engine === 'dlna') {
      var t = 'This TV plays the original file, so change audio and subtitles with the TV remote.';
      return { audio: { text: t, only: true }, subs: { text: t, only: true } };
    }
    var audio, subs;
    if (engine === 'chromecast') {
      audio = 'Changing the audio restarts the stream and may jump back a few seconds.';
      subs = 'Choosing a subtitle restarts the stream and may jump back a few seconds.';
    } else if (engine === 'receiver') {
      audio = 'You can also change this with the TV remote.';
      subs = 'You can also change this with the TV remote.';
    } else if (engine === 'airplay') {
      audio = ''; subs = '';
    } else return none;
    if (torrent) {
      audio = audio ? audio + ' ' + TORRENT : TORRENT;
      subs = subs ? subs + ' ' + TORRENT : TORRENT;
    }
    return {
      audio: audio ? { text: audio, only: false } : null,
      subs: subs ? { text: subs, only: false } : null
    };
  }

  /* The second line of a row in the cast menu: the route, and where the audio and subtitles are changed.
   * One short line, so the menu stays as narrow as a list of device names. */
  function routeDetail(kind, dual) {
    if (kind === 'dlna') return dual ? 'DLNA · original 4K · tracks on TV' : 'DLNA · original file · tracks on TV';
    if (kind === 'chromecast') return 'Google Cast · tracks on Mac';
    if (kind === 'airplay') return 'Choose a device · tracks on Mac';
    if (kind === 'receiver') return 'Spritz Receiver · tracks on Mac or TV';
    return '';
  }

  /* The full sentence, for a row's tooltip. */
  function routeTooltip(kind, dual) {
    if (kind === 'dlna') return (dual ? 'DLNA plays the original file, so 4K and HDR arrive untouched. ' : 'DLNA plays the original file. ')
      + 'Change audio and subtitles with the TV remote.';
    if (kind === 'chromecast') return 'Google Cast: the Mac converts the video. Change audio and subtitles here; a change restarts the stream.';
    if (kind === 'airplay') return 'AirPlay: change audio and subtitles here.';
    if (kind === 'receiver') return 'Spritz Receiver: change audio and subtitles here or with the TV remote.';
    return '';
  }

  var api = { trackNotes: trackNotes, routeDetail: routeDetail, routeTooltip: routeTooltip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzRouteHints = api;
})(typeof window !== 'undefined' ? window : this);
