import * as ExpoNetwork from 'expo-network';
import type { Network } from '@custar/learner-core';

/** Connectivity for Wi-Fi-only downloads. Mobile data is treated as metered. */
export const expoNetwork: Network = {
  async isOnline() {
    const state = await ExpoNetwork.getNetworkStateAsync();
    return Boolean(state.isConnected) && state.isInternetReachable !== false;
  },
  async isUnmetered() {
    const state = await ExpoNetwork.getNetworkStateAsync();
    return (
      Boolean(state.isConnected) &&
      (state.type === ExpoNetwork.NetworkStateType.WIFI ||
        state.type === ExpoNetwork.NetworkStateType.ETHERNET)
    );
  },
};
