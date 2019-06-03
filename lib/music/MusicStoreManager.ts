import {
    Track,
    requiresSpotifyAccessInfo,
    setCredentials,
    getPlaylistTracks,
    PaginationItem,
    PlaylistItem,
    PlayerName,
    CodyResponse,
    CodyResponseType,
    getPlaylists,
    getRunningTrack,
    PlayerType,
    PlaylistTrackInfo,
    PlayerDevice,
    getSpotifyDevices
} from "cody-music";
import { serverIsAvailable, getSpotifyOauth } from "../DataController";

import {
    softwareGet,
    isResponseOk,
    softwareDelete,
    softwarePut
} from "../HttpClient";
import { getItem } from "../Util";
import { PRODUCTIVITY_PLAYLIST_NAME } from "../Constants";
import { commands } from "vscode";
export class MusicStoreManager {
    private static instance: MusicStoreManager;

    private _spotifyPlaylists: PlaylistItem[] = [];
    private _runningPlaylists: PlaylistItem[] = [];
    private _codyPlaylists: PlaylistItem[] = [];
    private _codyFavorites: any[] = [];
    private _playlistTracks: any = {};
    private _currentPlayerType: PlayerType = PlayerType.NotAssigned;
    private _selectedPlaylist: PlaylistItem = null;
    private _hasPlaylists: boolean = false;
    private _spotifyPlayerDevices: PlayerDevice[] = [];

    private constructor() {
        //
    }

    static getInstance(): MusicStoreManager {
        if (!MusicStoreManager.instance) {
            MusicStoreManager.instance = new MusicStoreManager();
        }

        return MusicStoreManager.instance;
    }

    //
    // getters
    //

    get codyPlaylists(): PlaylistItem[] {
        return this._codyPlaylists;
    }

    set codyPlaylists(lists: PlaylistItem[]) {
        this._codyPlaylists = lists;
    }

    get spotifyPlaylists(): PlaylistItem[] {
        return this._spotifyPlaylists;
    }

    set spotifyPlaylists(lists: PlaylistItem[]) {
        this._spotifyPlaylists = lists;
    }

    get codyFavorites(): any[] {
        return this._codyFavorites;
    }

    get runningPlaylists(): PlaylistItem[] {
        return this._runningPlaylists;
    }

    set runningPlaylists(list: PlaylistItem[]) {
        this._runningPlaylists = list;
    }

    get selectedPlaylist(): PlaylistItem {
        return this._selectedPlaylist;
    }

    set selectedPlaylist(item: PlaylistItem) {
        this._selectedPlaylist = item;
    }

    get hasPlaylists(): boolean {
        return this._hasPlaylists;
    }

    set hasPlaylists(flag: boolean) {
        this._hasPlaylists = flag;
    }

    get spotifyPlayerDevices(): PlayerDevice[] {
        return this._spotifyPlayerDevices;
    }

    set spotifyPlayerDevices(devices: PlayerDevice[]) {
        this._spotifyPlayerDevices = devices;
    }

    //
    // store functions
    //

    async clearPlaylists() {
        this.selectedPlaylist = null;
        this.runningPlaylists = [];
        this.hasPlaylists = false;
    }

    async initializeSpotify() {
        if (!this.hasSpotifyAccessToken()) {
            let serverIsOnline = await serverIsAvailable();
            const spotifyOauth = await getSpotifyOauth(serverIsOnline);
            if (spotifyOauth) {
                // update the CodyMusic credentials
                setCredentials({
                    refreshToken: spotifyOauth.spotify_refresh_token,
                    clientSecret: "2b40b4975b2743189c87f4712c0cd59e",
                    clientId: "eb67e22ba1c6474aad8ec8067480d9dc",
                    accessToken: spotifyOauth.spotify_access_token
                });
            }
        }
    }

    async fetchCodyPlaylists() {
        let playlists = [];
        const response = await softwareGet("/music/playlist", getItem("jwt"));
        if (isResponseOk(response)) {
            playlists = response.data.map(item => {
                // transform the playlist_id to id
                item["id"] = item.playlist_id;
                delete item.playlist_id;
                return item;
            });
        }
        this.codyPlaylists = playlists;
    }

    async reconcilePlaylists() {
        let hasSpotifyPlaylists = this._spotifyPlaylists.length > 0;
        let hasUpdates = false;
        if (this._codyPlaylists.length > 0) {
            for (let i = 0; i < this._codyPlaylists.length; i++) {
                let codyPlaylist = this._codyPlaylists[i];

                if (hasSpotifyPlaylists) {
                    let foundItem = this._spotifyPlaylists.find(element => {
                        return element.id === codyPlaylist.id;
                    });
                    if (!foundItem) {
                        // the playlist was deleted, delete the one on software
                        await softwareDelete(
                            `/music/playlist/${codyPlaylist.id}`,
                            getItem("jwt")
                        );
                        hasUpdates = true;
                    } else if (foundItem.name !== codyPlaylist.name) {
                        // update the name on software
                        const payload = {
                            name: foundItem.name
                        };
                        await softwarePut(
                            `/music/playlist/${codyPlaylist.id}`,
                            payload,
                            getItem("jwt")
                        );
                        hasUpdates = true;
                    }
                } else {
                    // either access token as removed or playlist(s) were
                    // deleted. delete our copy of the playlist ID
                    await softwareDelete(
                        `/music/playlist/${codyPlaylist.id}`,
                        getItem("jwt")
                    );
                    hasUpdates = true;
                }
            }
        }

        if (hasUpdates) {
            await this.clearPlaylists();
            let track: Track = await getRunningTrack();
            await this.syncRunningPlaylists(track);

            commands.executeCommand("musictime.refreshPlaylist");
        }
    }

    /**
     * These are the top productivity songs for this user
     */
    async syncPlaylistFavorites() {
        const response = await softwareGet(
            "/music/playlist/favorites",
            getItem("jwt")
        );

        if (isResponseOk(response) && response.data.length > 0) {
            this._codyFavorites = response.data;
        } else {
            // clear the favorites
            this._codyFavorites = [];
        }
    }

    async syncRunningPlaylists(runningTrack: Track) {
        let playlists: PlaylistItem[] = [];

        runningTrack = runningTrack || new Track();

        this._currentPlayerType = runningTrack.playerType;

        if (
            runningTrack.playerType === PlayerType.NotAssigned ||
            !runningTrack.id
        ) {
            // no player or track
            let playlistItemTitle: PlaylistItem = new PlaylistItem();
            playlistItemTitle.tracks = new PlaylistTrackInfo();
            playlistItemTitle.type = "title";
            playlistItemTitle.id = "title";
            playlistItemTitle.playerType = PlayerType.NotAssigned;
            playlistItemTitle.name = "No active music player found";
            playlists.push(playlistItemTitle);
            this.addConnectToListIfNoAccessToken(playlists);
            this.runningPlaylists = playlists;
            return;
        }

        // also get the player devices
        this.spotifyPlayerDevices = await getSpotifyDevices();

        // get the cody playlists
        await this.fetchCodyPlaylists();

        if (this.spotifyPlayerDevices.length > 0) {
            // fetch spotify and sync what we have
            playlists = await this.syncSpotifyWebPlaylists();
            this._currentPlayerType = PlayerType.WebSpotify;
        } else if (runningTrack.playerType === PlayerType.MacItunesDesktop) {
            playlists = await getPlaylists(PlayerName.ItunesDesktop);
        }

        /**
         * playlist example...
            collaborative:false
            id:"MostRecents"
            name:"MostRecents"
            playerType:"MacItunesDesktop"
            public:true
            tracks:PlaylistTrackInfo {href: "", total: 34}
            type:"playlist"
         */

        if (playlists.length > 0) {
            this.hasPlaylists = true;
            // check if we need to update the ID to the name
            playlists.map((playlist: PlaylistItem) => {
                if (!playlist.id) {
                    playlist.id = playlist.name;
                }
                if (this._currentPlayerType === PlayerType.WebSpotify) {
                    let foundItem = this.codyPlaylists.find(element => {
                        return element.id === playlist.id;
                    });
                    if (foundItem) {
                        playlist.tag = "cody";
                    }
                }
            });
        }

        this.addConnectToListIfNoAccessToken(playlists);

        this.addTop40PlaylistLinkIfDoesntExist(playlists);

        this.runningPlaylists = playlists;
    }

    addConnectToListIfNoAccessToken(playlists: PlaylistItem[]) {
        if (!this.hasSpotifyAccessToken()) {
            // add the connect spotify link
            let connectSpotifyItem: PlaylistItem = new PlaylistItem();
            connectSpotifyItem.tracks = new PlaylistTrackInfo();
            connectSpotifyItem.type = "connectspotify";
            connectSpotifyItem.id = "connectspotify";
            connectSpotifyItem.playerType = PlayerType.WebSpotify;
            connectSpotifyItem.name = "Connect Spotify to see your playlists";
            playlists.push(connectSpotifyItem);
        }
    }

    addTop40PlaylistLinkIfDoesntExist(playlists: PlaylistItem[]) {
        if (this._currentPlayerType === PlayerType.WebSpotify) {
            let foundItem = null;
            for (let i = 0; i < playlists.length; i++) {
                let playlist = playlists[i];
                foundItem = this.codyPlaylists.find(element => {
                    return element.id === playlist.id;
                });

                if (foundItem) {
                    break;
                }
            }

            if (!foundItem) {
                // add the connect spotify link
                let connectSpotifyItem: PlaylistItem = new PlaylistItem();
                connectSpotifyItem.tracks = new PlaylistTrackInfo();
                connectSpotifyItem.type = "addtop40";
                connectSpotifyItem.id = "addtop40";
                connectSpotifyItem.playerType = PlayerType.WebSpotify;
                connectSpotifyItem.name = `Create a Spotify playlist`;
                connectSpotifyItem.tooltip = `Create a Spotify playlist (${PRODUCTIVITY_PLAYLIST_NAME}) based on your weekly top 40`;
                playlists.push(connectSpotifyItem);
            }
        }
    }

    async syncSpotifyWebPlaylists() {
        let playlists = [];
        if (this.hasSpotifyAccessToken()) {
            playlists = await getPlaylists(PlayerName.SpotifyWeb);
            if (playlists) {
                // update the type to "playlist";
                playlists.map(item => {
                    item.type = "playlist";
                });
            }
        }

        this.spotifyPlaylists = playlists;

        return this.spotifyPlaylists;
    }

    hasSpotifyAccessToken() {
        return requiresSpotifyAccessInfo() ? false : true;
    }

    hasTracksForPlaylistId(playlist_id: string): boolean {
        return this._playlistTracks[playlist_id] ? true : false;
    }

    async getTracksForPlaylistId(playlist_id: string) {
        let runningTrack: Track = await getRunningTrack();
        if (runningTrack.playerType !== this._currentPlayerType) {
            // clear the map
            this._playlistTracks[playlist_id] = null;
        }
        this._currentPlayerType = runningTrack.playerType;

        let playlistItems = [];
        let tracks = this._playlistTracks[playlist_id];
        if (tracks) {
            return tracks;
        }

        let playlistTracks: CodyResponse;

        if (this.spotifyPlayerDevices.length > 0) {
            // get the playlist tracks
            playlistTracks = await getPlaylistTracks(
                PlayerName.SpotifyWeb,
                playlist_id
            );
        } else if (this._currentPlayerType === PlayerType.MacItunesDesktop) {
            playlistTracks = await getPlaylistTracks(
                PlayerName.ItunesDesktop,
                playlist_id
            );
        } else {
            playlistTracks = await getPlaylistTracks(
                PlayerName.SpotifyDesktop,
                playlist_id
            );
        }

        if (playlistTracks.state === CodyResponseType.Success) {
            let paginationItem: PaginationItem = playlistTracks.data;
            if (paginationItem && paginationItem.items) {
                playlistItems = paginationItem.items.map((track: Track) => {
                    let playlistItem: PlaylistItem = new PlaylistItem();
                    playlistItem.type = "track";
                    playlistItem.name = track.name;
                    playlistItem.id = track.id;
                    playlistItem["artists"] = track.artists.join(", ");
                    playlistItem["playerType"] = track.playerType;
                    // since this is a track, delete the tracks attribute
                    delete playlistItem.tracks;
                    return playlistItem;
                });
            }

            this._playlistTracks[playlist_id] = playlistItems;
        }
        return playlistItems;
    }
}
