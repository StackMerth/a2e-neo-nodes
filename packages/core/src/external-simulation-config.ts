// External-market simulation mode toggle.
//
// Defaults to ON so that no adapter touches a real market until the client
// provides credentials and explicitly flips A2E_EXTERNAL_SIMULATION=false.

export function isSimulationMode(): boolean {
  return process.env.A2E_EXTERNAL_SIMULATION !== 'false'
}
