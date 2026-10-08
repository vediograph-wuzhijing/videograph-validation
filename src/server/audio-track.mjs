// One selection rule for live preview, frozen exports and review signatures.
export function selectedAudio(project) {
  const active = project.vocal?.active;
  return active ? { hash: active.mixHash, engineFile: `audio/vocal-${active.mixHash}.wav`, vocalJobId: active.jobId }
    : { hash: project.audio.hash, engineFile: project.audio.engineFile ?? 'audio/pdoom.mp3' };
}
