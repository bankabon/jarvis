// アイアンマン風リアクター。state: idle(青) / listening(緑) / thinking(橙) / speaking(脈動)
export default function Orb({ state = 'idle', size = 150 }) {
  return (
    <div className={`orb orb-${state}`} style={{ width: size, height: size }} aria-label={`状態: ${state}`}>
      <div className="ring r1" />
      <div className="ring r2" />
      <div className="ring r3" />
      <div className="core" />
    </div>
  )
}
