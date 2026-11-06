# Taiwan Cruise — 車輛操控開發 Prompt 包 v1.2

- **用途**：交給 Codex 分階段開發 three.js 賽車遊戲的「車輛操控」原型（不含場景）
- **手感目標**：Forza Horizon 預設輔助（ABS / TCS / STM 開、自動排檔）
- **內容**：AGENTS.md、Phase 1–7 任務 prompt、手感調校對照表、輪胎與輔助系統的 TypeScript 參考實作（已通過型別檢查與 18 項單元測試）

> **v1.1 修訂（參考實作經模擬驗證後）**
> 1. Phase 3 側向力公式：`MF_lat` 的參數應為 `s × tan(peakSlipAngle)`，v1.0 多套了一層 `atan`。
> 2. Phase 3 `gripUsage` 改為「正規化合成滑動量 s」（< 1 抓地、> 1 滑動）。v1.0 的定義永遠 ≤ 1，無法拿來判斷是否在滑。
> 3. Phase 3 車輪積分改為「線性化隱式」。低速時輪胎剛性極高，顯式積分在 480 Hz 下仍會發散。
> 4. Phase 3 低速駐車改為「錨點彈簧-阻尼」。純阻尼擋不住坡道重力，車會以等速慢慢滑。
> 5. Phase 5 TCS 增益改為 kp 0.25 / ki 5。v1.0 的 kp 2 / ki 10 會在全砍與恢復之間循環，加速反而比沒開 TCS 還差。

> **v1.2 修訂（全文審查）**
> 1. **懸吊 restLength 0.35 → 0.42 m**。原本的數值與「CoM 離地 0.50 m」矛盾：靜態壓縮約 0.10 m，用 0.35 m 車身會比規格低約 7 cm。
> 2. **車身 collider 必須往上偏移**（中心在 CoM 上方 0.35 m）。原本沒有指定，1.4 m 高的方塊若以 CoM 為中心，底部會插進地面 20 cm。
> 3. **車身剛體要關閉休眠**（setCanSleep(false)），並鎖定 Rapier 版本。否則低速時剛體會睡著，輪胎力施加不上去。
> 4. **後輪最大煞車扭力 1200 → 900 N·m**（前後比 65% → 71%）。1 g 煞車時前後負載約 71/29，原本的比例會讓後輪先鎖死，sim 模式（無 ABS）下重煞會打滑旋轉。
> 5. **自動排檔加入遲滯**。原本 kick-down 的門檻（redline − 300 = 6500）剛好等於全油門升檔點，會在兩檔之間來回跳。
> 6. **倒檔改為「停住後重新踩煞車」才進入**，並補上「回到 D 檔」的規則。原本「停住後持續踩煞車 0.25 s 就進倒檔」，會讓在坡道上踩住煞車的車開始倒退，與「15% 坡道踩煞車不滑動」的驗收互相矛盾。
> 7. **STM 的目標 yaw 改用駕駛意圖輪角**（轉向輔助之前）。原本用含自動反打的輪角，甩尾回正時會煞錯邊，把車甩到另一側。
> 8. **轉向輔助的窗口只限制幅度**，不會主動把輪子轉到另一側；反打全部交給 countersteer，避免兩者疊加反打過頭。
> 9. **自動反打門檻改為 peakSlipAngle × 1.1 ≈ 9°**。v1.1 的 6° 仍低於後輪峰值滑動角 8°，正常極限過彎時就會介入。
> 10. **新增低速橫向阻尼**。模擬發現停車後若有些微側向速度，輪胎鬆弛模型會像阻尼很小的 6 Hz 彈簧，第 2–3 秒仍有 0.011 m/s 晃動，超過驗收值 0.01 m/s。
> 11. **轉向平滑只做一次**。原本 Phase 4 的速率限制（3 /s）和 Phase 6 的鍵盤漸變重疊，鍵盤設定會失效，手把也會多一層延遲。現在統一在 Steering.ts 依裝置設定。
> 12. **sport 預設的「TCS 低」補上具體數值**；ABS 的 brakeCmd 明確定義為「玩家 + STM」的總煞車需求。
> 13. 參考程式碼的 package.json 補上 typecheck / test 指令。

## 使用方式

1. 建立新的 repo，把下方的 **AGENTS.md** 放到根目錄。
2. 把附帶的 `handling-reference.zip`（第五章的程式碼）解壓縮，得到 `reference/` 資料夾，放進 repo 根目錄，Codex 實作 Phase 3 和 Phase 5 時要對照。
3. **一次只貼一個 Phase** 給 Codex，自己試開確認後，再貼下一個。
4. Phase 1–4 先求物理正確（數值合理、不抖、測試通過），Phase 5 之後才開始調「感覺」。

---

# 一、AGENTS.md（放在 repo 根目錄）

````markdown
# 專案：Taiwan Cruise — 車輛操控原型

## 目標
使用 three.js + Rapier 開發一個瀏覽器賽車操控原型，手感目標為「Forza Horizon 預設輔助（ABS/TCS/STM 開、自動排檔）」：
好上手、可預期、不會突然失控，但仍能感受到重量轉移、抓地極限、推頭/甩尾。
本階段「只做車子與測試場」，不做真實地景。

## 技術棧（不得自行更換）
- TypeScript (strict) + Vite
- three.js（WebGLRenderer 即可，之後才換 WebGPU）
- @dimforge/rapier3d-compat（package.json 鎖定精確版本，不用 ^）：只用於「車身剛體 + 世界碰撞 + raycast」
  - 車身剛體必須 setCanSleep(false)，否則低速時會休眠，輪胎力施加不上去
  - 不使用 Rapier 內建的 DynamicRayCastVehicleController，懸吊/輪胎/動力系統全部自己寫
- Tweakpane：即時調參
- Vitest：單元測試
- 不使用 React / R3F

## 參考實作
reference/ 內有輪胎、車輪積分、駐車力、ABS/TCS/STM/轉向輔助的參考程式碼與測試。
實作 src/vehicle/ 時，公式、符號約定、數值穩定性處理必須與參考實作一致；可以重構，但不得改變行為。

## 單位與座標
- 全部使用 SI 單位：m、kg、s、N、N·m、rad、rad/s。UI 顯示才轉 km/h、度、rpm。
- 右手座標，Y 軸朝上。車身 local：前方 = -Z、右方 = +X、上方 = +Y（與 three.js 相機慣例一致）。
- 車身 local 原點 = 質心（CoM）。
- 輪角 > 0 = 向右；yawRateRight = −ω_y（> 0 表示車頭往右轉）。

## 架構規則
1. 模擬與渲染分離：
   - 物理固定步長 PHYSICS_HZ = 120（可設定為 240），使用 accumulator；每幀最多跑 8 個步長，避免 spiral of death。
   - 渲染端用前後兩個物理狀態做插值（位置 lerp、旋轉 slerp）。
2. 車輛模擬是純邏輯模組（src/vehicle/**），不得 import three.js；只能依賴一個小型的 Vec3/Quat 數學工具，以及一個 PhysicsAdapter 介面（包裝 Rapier）。這樣之後才能拿到伺服器上跑，也方便寫單元測試。
3. 每一步的輸入是一個可序列化的 VehicleInput：{ steer: -1..1, throttle: 0..1, brake: 0..1, handbrake: 0..1, shiftUp: bool, shiftDown: bool }。
4. 車輛狀態必須能序列化成 VehicleState（車身位置/旋轉/線速度/角速度、每輪 ω、輪胎鬆弛狀態、懸吊壓縮量、引擎 rpm、檔位、輔助系統內部狀態），供 replay 與未來的多人同步使用。
5. 所有車輛參數集中於 /src/vehicle/presets/*.json，程式碼中不得出現魔術數字。Tweakpane 可即時修改，並支援匯出/匯入 JSON。
6. 決定性（determinism）：同一個初始狀態 + 同一串輸入，在同一台機器、同一個瀏覽器上必須得到相同結果。不得在模擬中使用 Math.random 或 Date.now。
   （跨瀏覽器的 Math.sin/atan 等結果可能有末位差異，所以多人連線不能依賴決定性，必須靠狀態同步。）
7. 每完成一個 Phase：npm run typecheck、npm run test、npm run build 必須全部通過。

## 目錄
src/
  core/      loop.ts（固定步長、插值）、input/（鍵盤、手把）、math/
  physics/   PhysicsAdapter.ts、RapierAdapter.ts
  vehicle/   Vehicle.ts、Suspension.ts、Tire.ts、Wheel.ts、Hold.ts、Drivetrain.ts、Engine.ts、Gearbox.ts、Differential.ts、Brakes.ts、Aero.ts、Steering.ts、assists/（PI.ts、abs.ts、tcs.ts、stm.ts、steeringAssist.ts）、presets/
  render/    VehicleView.ts（方塊車身 + 圓柱輪子）、TestTrack.ts
  camera/    ChaseCamera.ts、HoodCamera.ts
  debug/     Telemetry.ts、TuningPanel.ts、Graphs.ts、Replay.ts
reference/   參考實作（唯讀）
tests/

## 預設車輛 presets/default.json（初始值，之後調校）
- 質量 1350 kg；車身尺寸 1.8(W) × 1.4(H) × 4.4(L) m
- 慣性主軸（local）：Ixx(pitch)=2400、Iyy(yaw)=2550、Izz(roll)=600 kg·m²
- 軸距 2.65 m；前軸在 CoM 前方 1.27 m，後軸在 CoM 後方 1.38 m（前 52% / 後 48%）
- 輪距 前 1.55 / 後 1.55 m；懸吊掛載點位於 CoM 上方 0.15 m
- CoM 離地高度（靜止時）約 0.50 m
- 輪胎半徑 0.33 m；車輪轉動慣量 1.0 kg·m²（含煞車碟）
- 車身 collider：方塊 1.8 × 1.4 × 4.4 m，中心位於 CoM 上方 0.35 m（底部離地約 0.15 m）
- 懸吊：restLength 0.42 m、行程 0.20 m（bump stop 在壓縮 0.18 m 開始，剛性 ×10）
  - 檢查：掛載點離地 0.65 m − 輪胎半徑 0.33 m = 0.32 m；restLength 0.42 − 靜態壓縮約 0.10 = 0.32 ✓
  - 彈簧 k：前 34000、後 32000 N/m
  - 阻尼：bump 前 2100 / 後 2000、rebound 前 3400 / 後 3200 N·s/m
  - 防傾桿：前 15000、後 9000 N/m
- 輪胎：
  - 縱向 peakSlipRatio 0.10、C_long 1.5、μ_long 1.10
  - 側向 peakSlipAngle 8°、C_lat 1.30、μ_lat 1.05
  - 負載敏感度 loadSensitivity 0.10、nominalLoad 3300 N
  - relaxationLength 側向 0.35 m、縱向 0.10 m
- 駐車錨點：engageSpeed 0.3、releaseSpeed 0.5 m/s、頻率 3 Hz、阻尼比 1.0
- 低速橫向阻尼：fadeStart 1、fadeEnd 3 m/s、頻率 6 Hz、阻尼比 0.7
- 引擎：idle 900、redline 6800、limiter 7000 rpm；引擎慣量 0.20 kg·m²
  - 扭力曲線 rpm:N·m = 1000:200, 2000:300, 3000:350, 4000:350, 5000:340, 6000:310, 7000:260
  - 引擎煞車扭力 = 30 + 0.006 × rpm（N·m，油門 0 時）
- 變速箱：檔比 [3.40, 2.20, 1.60, 1.25, 1.00, 0.82]、倒檔 3.20、終傳 3.70、換檔時間 0.15 s、傳動效率 0.90
- 驅動：RWD（支援 FWD / RWD / AWD；AWD 前後扭力分配預設 40/60）
- 差速器：LSD（type: open | lsd | locked），lsd 預載 50 N·m、鎖定係數 0.25
- 煞車：每輪最大扭力 前 2200 / 後 900 N·m（前 71%，對應 1 g 煞車時的前後負載）；手煞車後輪 2500 N·m
- 空力：CdA 0.72 m²、ClA（下壓）0.30 m²（前 45% / 後 55%）、空氣密度 1.225
- 滾動阻力係數 0.012
- 轉向：低速最大輪角 33°、Ackermann 0.6
  - 輸入平滑（只在 Steering.ts 做一次，依裝置）：鍵盤轉入 0→1 需 0.18 s（低速）~ 0.35 s（高速）、回正 0.12 s；手把轉入 0.08 s、回正 0.06 s；方向盤不平滑
- 輔助：ABS kp 1.5 / ki 20；TCS kp 0.25 / ki 5；STM kp 2500 / ki 4000；轉向輔助 strength 0.7、反打 gain 0.6、門檻 9°（= peakSlipAngle × 1.1）

## 手感驗收目標（使用 "forza_normal" 輔助預設）
- 0→100 km/h：6.0–7.5 s；極速 230–260 km/h
- 100→0 km/h 煞車：36–42 m，ABS 啟動時方向仍可控
- 半徑 50 m 定圓：穩態側向加速度 0.95–1.05 g
- 靜止不動 2 秒後，車身速度 < 0.01 m/s；在 15% 坡道踩住煞車 5 秒位移 < 2 cm
- 120 Hz 與 240 Hz 下行為差異小（0→100 誤差 < 3%）
- 任何輸入組合都不會出現 NaN、車身爆飛或高頻抖動
````

---

# 二、分階段任務 Prompt

## Phase 1：專案骨架、固定步長迴圈、測試場、剛體

````markdown
請先閱讀 AGENTS.md，再完成 Phase 1。

1. 用 Vite + TS strict 建立專案，安裝 three、@dimforge/rapier3d-compat、tweakpane、vitest。
   建立 scripts：dev、build、typecheck、test。
2. core/loop.ts：固定步長 accumulator（PHYSICS_HZ 可設定），每幀最多 8 步。
   提供 alpha 給渲染插值。分頁切走後回來時，不得一次補跑大量步長。
3. physics/PhysicsAdapter.ts 定義介面：
   createChassis(desc) / castRay(origin, dir, maxDist, excludeBody) → { hit, point, normal, distance, colliderUserData }
   applyImpulseAtPoint、applyTorqueImpulse、getLinVel、getAngVel、getPose、setPose、step(dt)。
   RapierAdapter.ts 實作此介面：
   - 車身 collider 的 density 設為 0，用 setAdditionalMassProperties 精確指定質量、CoM、主慣性（依 preset）。
   - 車身 collider 中心放在 CoM 上方 0.35 m（依 preset），不要以 CoM 為中心，否則底部會插進地面。
   - 車身剛體 setCanSleep(false)。
   - 「接觸點速度」自行計算：v + ω × (p − com_world)。
   - 外力一律以「力 × dt 的衝量」在每個物理步長施加。
4. render/TestTrack.ts（只用基本幾何體，地面加上格線貼圖以便感受速度）：
   - 2 km × 2 km 平地
   - 半徑 50 m 定圓（地上畫線）
   - 間距 20 m 的繞錐 10 支
   - 一段 8% 與一段 15% 坡道
   - 連續髮夾彎 4 個（內半徑 12 m、帶 8% 坡度，模擬台14甲）
   - 小顛簸路段（正弦起伏，振幅 5 cm、波長 3 m）
   - 低摩擦區（collider userData 帶 surfaceGrip = 0.7，代表濕地）
   - 外傾 10° 的彎道一個
   每個 collider 的 userData 帶 { surfaceGrip, surfaceType }。
5. render/VehicleView.ts：方塊車身 + 4 個圓柱輪子（之後會換 GLB，所以要保留 setModel 介面）。
6. 此階段車輛先只做剛體，不做懸吊。按 R 可重置到起點。
驗收：可以跑起來、看到測試場；車身方塊從 1 m 高落下會穩定停住；typecheck/test/build 通過。
````

## Phase 2：Raycast 懸吊

````markdown
請先閱讀 AGENTS.md，完成 Phase 2：懸吊（Suspension.ts）。

每個物理步長、每個輪子：
1. 由掛載點（車身 local → world）沿車身 -Y 方向 raycast，長度 = restLength + wheelRadius。
   沒有打到地面 → 視為離地：懸吊伸長到 restLength，Fz = 0。
2. 壓縮量 x = restLength − (hitDistance − wheelRadius)，clamp 到 [0, travel]。
   壓縮速度 v_c = (x − x_prev) / dt。
3. 懸吊力：F = k·x + c·v_c（v_c > 0 使用 bump 阻尼，< 0 使用 rebound 阻尼）。
   x > bumpStopStart 時，額外加上 bump stop 力。F 最小為 0（不能把車往下拉）。
4. 防傾桿：F_arb = k_arb × (x_left − x_right)；壓縮較多的一側加上 F_arb，另一側減去 F_arb（結果仍 clamp ≥ 0）。
5. 施力方向 = 接觸面法線（預設），施力點 = 接觸點。
6. Fz（輪胎法向負載）= 最終懸吊力，提供給下一階段的輪胎模型。
7. VehicleView 中，輪子的視覺高度要跟著懸吊位置移動。
Debug：用 Tweakpane 即時調整 k、c、arb；畫面上以 4 條長條顯示每輪 Fz（N）與壓縮量。

單元測試：
- 靜止平衡：車放在平地 3 秒後，4 輪 Fz 總和 = m·g ±1%，前後比例 ≈ 52/48 ±2%。
- 從 0.3 m 高度落下：不得穿地，1.5 秒內停止震盪（車身垂直速度 < 0.02 m/s）。
- 120 Hz 與 240 Hz 的穩態壓縮量差異 < 2%。
````

## Phase 3：輪胎模型（手感核心，要精確實作）

````markdown
請先閱讀 AGENTS.md，完成 Phase 3：Tire.ts、Wheel.ts、Hold.ts。
請以 reference/src/vehicle/Tire.ts、Wheel.ts、Hold.ts 為準，並把 reference/tests 裡相關的測試搬進 tests/。

座標：在接觸面上，用車輪朝向投影出 wheelForward（滾動方向）與 wheelRight，兩者都要投影到接觸平面並正規化。
v_contact = 接觸點的世界速度；v_x = dot(v_contact, wheelForward)；v_y = dot(v_contact, wheelRight)。

1. 滑動率與滑動角
   - 縱向滑動率 κ = (ω·r − v_x) / max(|v_x|, |ω·r|, V_EPS)，V_EPS = 0.5 m/s
   - 穩態滑動角 α_ss = atan2(v_y, max(|v_x|, V_EPS))，往右滑為正
   - 鬆弛長度：α += (α_ss − α) × (1 − exp(−(|v_x| + V_RELAX_MIN) / σ_lat × dt))，κ 同樣處理（用 σ_long）
     V_RELAX_MIN = 1.0 m/s。使用解析解形式，dt 再大也不會發散。

2. 曲線（正規化 Magic Formula，E = 0）
   MF_n(s; C) = sin(C · atan(tan(π / 2C) · s))，s = 1 時為峰值 1.0
   C 必須在 (1, 2) 之間。C_lat = 1.30 時完全滑動後仍保有約 89% 抓地力，這就是 Forza 那種「寬容」的關鍵。

3. 負載敏感度
   loadFactor = clamp(1 − loadSensitivity × (Fz / nominalLoad − 1), 0.3, 1.5)
   μ_eff = μ × surfaceGrip × loadFactor

4. 合成滑動（摩擦圓），使用正規化滑動法：
   s_x = κ / peakSlipRatio，s_y = tan(α) / tan(peakSlipAngle)，s = √(s_x² + s_y²)
   若 s < 1e-9 → F = 0
   否則：
     F_x =  μ_eff_long × Fz × MF_n(s; C_long) × (s_x / s)
     F_y = −μ_eff_lat  × Fz × MF_n(s; C_lat)  × (s_y / s)
   gripUsage = s（< 1 抓地區、= 1 峰值、> 1 滑動中），提供給遙測、TCS、ABS、胎痕使用。

5. 車輪轉動（Wheel.ts）— 必須使用線性化隱式積分
   I·dω/dt = T_drive − r·F_x(ω) − T_resist
   - 每個物理步長跑 WHEEL_SUBSTEPS = 4 次子步進；子步進期間車身速度固定，每個子步進都重算輪胎力，
     最後把平均的 F_x、F_y 當作衝量施加給車身。
   - 低速時 ∂F_x/∂ω 極大，顯式積分會發散。所以每個子步進：
     K = max(0, ∂F_x/∂ω)（數值微分，eps = 1e-3 × max(1, |ω|)）
     ω_free = ω + h·(T_drive − r·F_x0) / (I + h·r·K)
     resist = h·(T_brake + T_rolling) / (I + h·r·K)
     |ω_free| ≤ resist → ω = 0（鎖死，不跨零震盪）；否則 ω = ω_free − sign(ω_free)·resist
   - 輪胎力施力點 = 接觸點；方向 = F_x·wheelForward + F_y·wheelRight。

6. 低速駐車（Hold.ts）— 錨點彈簧-阻尼
   純阻尼擋不住坡道重力分量，車會等速慢慢滑，所以要用錨點：
   - 條件：throttle < 0.05 且 brake（含手煞車）> 0.05，且接觸點平面速度 < 0.3 m/s → 記錄接觸點為錨點
   - 力 = −k·(p − anchor) − c·v（只取接觸平面分量），k = m_corner·(2π·3Hz)²，c = 2·1.0·m_corner·(2π·3Hz)
   - |力| > μ_eff·Fz：力限制在 μ_eff·Fz，錨點跟著滑動（等於靜摩擦被突破）
   - 速度 > 0.5 m/s 或條件不成立 → 解除
   - 低速橫向阻尼（lowSpeedLateralDamping，不需要踩煞車也作用）：
     F = −c·v_y × (1 − smoothstep(1, 3, |v_x|))，c = 2·0.7·m_corner·(2π·6Hz)，限制在 μ_eff·Fz，與輪胎 F_y 相加
     原因：|v_x| ≈ 0 時，鬆弛模型等效成一根阻尼很小的 6 Hz 側向彈簧，停車後會左右微晃

7. 這個階段先暫時用簡單驅動測試：油門直接給後輪 T = throttle × 1500 N·m，
   煞車用 preset 的煞車扭力，轉向直接把前輪轉 steer × 30°。

Debug：
- 每輪顯示 κ、α（度）、F_x、F_y、gripUsage（顏色：綠 < 0.8、黃 0.8–1.0、紅 > 1.0）
- 在每輪上方畫一個摩擦圓小圖（圓 + 目前的力向量）
- 用 Tweakpane 調整全部輪胎參數；另外即時畫出 MF 曲線圖（縱向與側向），參數一改曲線就更新

單元測試（reference/tests 已有對應版本）：
- MF 曲線在 s = 1 處 = 1.0；s → ∞ 時趨近 sin(Cπ/2)
- 合成力在任意 κ、α 下 |F| ≤ μ_eff·Fz
- 平地靜止 + 未踩油門：5 秒後位移 < 1 cm
- 15% 坡道踩住煞車：5 秒內位移 < 2 cm
- 停車時給 0.2 m/s 側向速度：2 秒後 |v_y| < 0.001 m/s
- 鎖死煞車：ω 最終為 0 且不跨零震盪
- 不得產生 NaN（固定種子隨機輸入跑 10,000 步）
````

## Phase 4：動力系統（引擎、變速箱、差速器、煞車、空力）

````markdown
請先閱讀 AGENTS.md，完成 Phase 4：Engine、Gearbox、Differential、Brakes、Aero、Steering。移除 Phase 3 的暫時驅動。

1. Engine.ts
   - 扭力曲線使用 preset 表格，以 monotone cubic（或線性）插值
   - T_engine = throttle × T_curve(rpm) − (1 − throttle) × T_engineBrake(rpm)
   - 超過 limiter：切斷燃油（throttle 視為 0），並以 20 Hz 脈衝恢復，產生撞限轉的感覺
   - rpm 最低為 idle（怠速控制器：rpm < idle 時補扭力）
2. 離合器與自動起步
   - 自動離合器：車輪換算 rpm < 1500 時進入半離合狀態，離合器傳遞扭力 = clutchCapacity × engagement，
     engagement 隨 rpm 差平滑變化；完全結合後，引擎 rpm 由車輪換算 rpm 決定（剛性連結）
   - 引擎與傳動系的慣量要計入驅動輪的等效慣量：I_eff = I_w + I_engine × (gear × final)² / 驅動輪數
     （I_eff 就是 Wheel.ts 的 inertiaEff）
3. Gearbox.ts（自動模式為預設，也支援手動 shiftUp/shiftDown）
   - upshiftRpm(throttle) = lerp(3500, 6500, throttle)；rpm > upshiftRpm → 升檔
   - 降檔：rpm < lerp(1800, 3500, throttle)；或 kick-down：throttle > 0.9 且降檔後 rpm < upshiftRpm(throttle) − 500
     （−500 的遲滯是必要的，否則 kick-down 門檻等於升檔點，會在兩檔之間來回跳）
   - 任何兩次換檔之間至少間隔 0.5 s（升檔、降檔都算）
   - 換檔期間 0.15 s 切斷扭力
   - 倒檔（Forza 行為，但避免坡道上踩住煞車就開始倒退）：
     - 進入：車速 < 1 km/h，且車子「停住之後」煞車有放開再踩下（煞車踩著一路停下來的話，不會進倒檔），brake > 0.5 持續 0.25 s
     - 倒檔中 brake 與 throttle 對調
     - 離開：倒檔中車速 < 1 km/h 且玩家按下原本的油門鍵（throttle > 0.5）→ 回到 1 檔
   - 轉彎中（側向 g > 0.6）延後升檔，避免彎中失去動力
4. Differential.ts
   - open：左右扭力平分
   - lsd：轉移扭力 = clamp(preload + lockCoef × |T_in|, 0, ...) × sign(ω_l − ω_r)，由快的一側移到慢的一側
   - locked：以強阻尼耦合左右 ω
   - AWD：中央差速器依前後分配比例分配扭力，再交給前後 LSD
5. Brakes.ts：brake 輸入 → 每輪扭力（依 preset 的前後最大值，前 2200 / 後 900）；手煞車只作用在後輪
6. Aero.ts：F_drag = 0.5ρ·CdA·v²（方向與速度相反，施加在 CoM）；
   下壓力 0.5ρ·ClA·v²，依前後比例施加在前後軸中點；滾動阻力 = Crr × Fz × r（作為 Wheel 的 resistTorque）
7. Steering.ts（只處理機構，輔助在 Phase 5）
   - 輸入 steer → 方向盤角，再乘上隨速度變化的上限：maxAngle(v) = max(6°, 33° / (1 + v / 15))，v 為 m/s
   - Ackermann：內側輪角較大，依 Ackermann 係數混合
   - 輸入平滑只在這裡做一次，依裝置使用 AGENTS.md 的數值（鍵盤、手把、方向盤各一組）；Phase 6 的輸入層只負責死區與曲線

HUD：速度 km/h、rpm 指針、檔位、油門/煞車條、手煞車指示。

單元測試與驗收：
- 0→100 km/h 在 6.0–7.5 s（輔助全開、自動排檔）
- 極速 230–260 km/h
- 換檔時 rpm 連續，車身不會被猛拉
- 原地全油門時起步平順（Phase 5 開 TCS 之後再驗一次）
- 120 Hz 與 240 Hz 下 0→100 時間差 < 3%
````

## Phase 5：輔助系統（讓手感變成 Forza 的關鍵）

````markdown
請先閱讀 AGENTS.md，完成 Phase 5：assists/*。請以 reference/src/vehicle/assists/ 為準。
每個輔助系統都要能個別開關與調整強度，並提供三組 preset：
- forza_normal：ABS 開、TCS 開、STM 開、steeringAssist 開（強度 0.7）、countersteer 開、自動排檔
- sport：ABS 開、TCS 低（engageRatio 1.6、kp 0.15、ki 3）、STM 關、steeringAssist 0.3、countersteer 關、自動排檔
- sim：全部關閉、手動排檔

處理順序（每個物理步長）：
Steering（機構）→ steeringAssist → 計算輪角 → TCS（引擎扭力倍率）→ STM（每輪附加煞車 + 油門倍率）→ ABS（每輪煞車壓力倍率）→ Wheel/Tire

1. steeringAssist.ts（最重要）
   - 最佳滑動角窗口：β_f = atan2(前軸側向速度, max(前軸前進速度, 1))，α_t = peakSlipAngle × 1.05
     玩家向右打（δ > 0）：δ_w = min(δ, max(β_f + α_t, 0))；向左打：δ_w = max(δ, min(β_f − α_t, 0))；不打：0
     也就是窗口只「限制幅度」，絕不主動把輪子轉到玩家沒打的那一側（反打交給下一項，避免疊加反打過頭）。
     再以 strength × smoothstep(5, 10, 速度) 與玩家輪角混合。
     效果：打滿方向盤時剛好在抓地極限，推頭時不會越打越推。
   - 自動反打：β_r = atan2(後軸側向速度, max(後軸前進速度, 1))；|β_r| > peakSlipAngle × 1.1（≈ 9°）時
     反打角 = 0.6 × (β_r − sign(β_r)·門檻)，限制在 ±15°，同樣乘上 fade。
     門檻不可低於後輪峰值滑動角，否則正常極限過彎時就會介入，感覺像推頭。
     玩家已經在反打（同號）時取較大的反打量，不跟玩家打架；異號時相加。
2. stm.ts（以 yaw rate 控制）
   - r_target = v·δ_driver / (L + K_us·v²)，K_us = 0.0025，限制在 ±0.85·μ·g / v
   - δ_driver 是 Steering.ts 的機構輸出（轉向輔助「之前」）。不可用含自動反打的實際輪角，
     否則甩尾回正時 r_target 會指向另一側，STM 誤判成轉向不足而煞錯邊，把車甩到另一側。
   - 過度轉向（r 與 r_target 異號，或 |r| − |r_target| > 0.08 rad/s）：PI 控制煞「前外側輪」（上限 800 N·m），降低油門
   - 轉向不足（|r_target| − |r| > 0.08）：PI 控制輕煞「後內側輪」（上限 400 N·m），稍降油門
   - 輸出以一階低通 τ = 0.05 s 平滑；速度 < 15 km/h 時停用
3. tcs.ts
   - 驅動輪最大 κ > peakSlipRatio × 1.15 → 啟動；以目標 κ = peakSlipRatio 的 PI 控制器（kp 0.25、ki 5）降低引擎扭力倍率
   - 降扭立即生效，恢復速率上限 3 /s；手煞車拉著時停用（讓玩家可以甩尾）
   - 注意：kp 太大（例如 2）會在全砍與恢復之間循環，加速反而比沒開 TCS 還差
4. abs.ts
   - 輸入的 brakeCmd 是該輪的總煞車需求（玩家煞車 + STM 附加煞車）
   - 每輪 κ < −peakSlipRatio × 1.15 → 啟動；以目標 κ = −peakSlipRatio 的 PI 控制器（kp 1.5、ki 20）調變煞車壓力
   - 不做 bang-bang 脈衝；另外輸出 15 Hz、±5% 的 hudPulse，只用於 HUD 與手把震動
   - 速度 < 5 km/h 時停用，讓車可以完全停下（之後由 Hold 接手）
5. 煞車時穩定性：全力直線煞車時，若出現 yaw，STM 優先修正
6. HUD：ABS / TCS / STM / ASSIST 四個指示燈，作用時亮起

驗收（forza_normal）：
- 100→0 煞車 36–42 m；煞車過程中打方向仍能轉向
- 半徑 50 m 定圓：穩態側向 0.95–1.05 g，油門加大時是平滑的推頭，不會突然甩尾
- 繞錐 60 km/h 不會失控；sim 模式下同樣的操作可以甩尾
- 手煞車進彎時可以甩尾，放開後 STM + 自動反打在 1 秒內把車救回
- 逐一開關每個輔助系統，行為差異要明顯且合理
````

## Phase 6：輸入、鏡頭、回饋

````markdown
請先閱讀 AGENTS.md，完成 Phase 6。

1. 輸入（core/input）
   - 鍵盤：W/S 或 ↑/↓ 油門/煞車，A/D 或 ←/→ 轉向，Space 手煞車，Q/E 換檔，C 切換鏡頭，R 重置，T 切換輔助 preset
     - 數位轉類比：油門 0→1 需 0.10 s、煞車 0.08 s；轉向的平滑在 Steering.ts（見 AGENTS.md），這裡不要重複做
   - 手把（Gamepad API，標準 mapping）：左搖桿轉向、RT 油門、LT 煞車、A 手煞車、LB/RB 換檔
     - 死區 0.08（radial），反應曲線 pow(x, steerExponent)，steerExponent 預設 1.4，
       另外提供 steerLinearity 與 steerSensitivity 設定
     - 扳機死區 0.05
   - 方向盤：以 Gamepad API 讀取軸，用 calibration UI 讓玩家選軸與方向（力回饋不做）
   - 所有設定存在 localStorage
2. 追車鏡頭 ChaseCamera.ts（使用插值後的車身 transform，在渲染幀中更新）
   - 目標位置：車後 5.8 m、上方 1.7 m，看向車前 2 m、高 1.0 m 的點
   - 鏡頭以 critically damped spring 跟隨（位置 4 Hz、旋轉 6 Hz），yaw 以「速度方向」與「車頭方向」混合（甩尾時能看到車身側面）
   - FOV：60° → 72°（隨 0–200 km/h 變化，平滑）
   - 加速時鏡頭微微後拉、煞車時前推（最大 0.3 m）
   - 顛簸時鏡頭依車身垂直加速度做輕微震動（可關閉）
   - 不得穿進地面（做簡單的地面高度檢查）
3. HoodCamera.ts：引擎蓋視角，加上依 pitch/roll 輕微晃動
4. 回饋
   - 手把震動（若支援 vibrationActuator）：gripUsage > 1 時弱震動、ABS 作用時跟著 hudPulse、碰撞時強震動
   - 地面胎痕：gripUsage > 1.1 時畫 decal 線條（ring buffer，最多 2000 段）
   - 胎煙：簡單粒子，gripUsage > 1.3 時產生

驗收：鍵盤與手把都能順暢駕駛；過彎時鏡頭不暈、不抖；以 30 fps 與 144 fps 渲染時操控感一致。
````

## Phase 7：遙測、調參、Replay（調手感的工具）

````markdown
請先閱讀 AGENTS.md，完成 Phase 7：調校工具。

1. Telemetry.ts：每個物理步長記錄一筆資料到 ring buffer（最近 20 秒）：
   速度、側向/縱向 g、yaw rate、r_target、車身滑動角 β、每輪的 Fz/κ/α/F_x/F_y/gripUsage/ω、
   steer 輸入與實際輪角、throttle/brake（玩家輸入與輔助修正後兩組）、rpm、檔位、各輔助作用量
2. Graphs.ts：可以選擇欄位的即時折線圖（canvas 2D，不要引入大型圖表套件），預設顯示：
   - 側向 g + yaw rate + r_target
   - 前後軸平均滑動角
   - 4 輪 gripUsage
   - g-g 圖（側向 vs 縱向加速度散佈圖）
3. TuningPanel.ts（Tweakpane）：分組列出 preset 所有參數；提供「重設為預設」「匯出 JSON」「匯入 JSON」「複製為 preset 檔」按鈕
4. Replay.ts：
   - 錄製：初始 VehicleState + 每步 VehicleInput
   - 播放：重新模擬並驗證最後的 state hash 一致（決定性測試）
   - 可以改參數後用同一段輸入重播，比較兩組遙測曲線（疊圖）
   - 匯出/匯入 .replay.json
5. 自動化測試腳本（vitest，headless 模式，不需渲染）：
   - acceleration_0_100、braking_100_0、skidpad_r50、slalom_60kmh、handbrake_turn、standstill_slope15
   - 每個測試輸出關鍵數值，並對照 AGENTS.md 的驗收目標
   - npm run handling-report 產生一份 markdown 報告（每個項目的數值與通過/失敗）

驗收：npm run handling-report 全部通過；replay 決定性測試通過。
````

---

# 三、試車時的「症狀 → 調整」對照表

開起來覺得哪裡不對時，把症狀加上 Phase 7 的遙測截圖貼給 Codex，請它依照這張表調整 preset：

| 症狀 | 優先調整 |
|---|---|
| 推頭，打方向盤車子不太轉 | 前輪 μ_lat 調高、前防傾桿調軟、peakSlipAngle 調小、K_us 調小 |
| 太容易甩尾 | 後防傾桿調軟、後輪 μ_lat 調高、C_lat 調低（滑動後保留更多抓地）、STM 門檻調低 |
| 方向盤反應太靈敏、太跳 | σ_lat 鬆弛長度加大、轉向速率限制調慢、steerExponent 調高 |
| 方向盤反應太鈍、有延遲 | σ_lat 調小、鏡頭旋轉 spring 頻率調高 |
| 車身像船一樣搖晃 | 阻尼調高（尤其 rebound）、彈簧與防傾桿調硬 |
| 車身太硬、過顛簸會彈跳 | 彈簧調軟、bump 阻尼調低 |
| 失控後很難救回來 | countersteerGain 調高、STM 增益調高、C_lat 調低 |
| 正常過彎就覺得被輔助拉住 | countersteerThreshold 調高、steeringAssist targetRatio 調高（例 1.15） |
| 煞車點頭太多 | 前彈簧和前 bump 阻尼調高、CoM 高度調低 |
| 起步燒胎 | TCS 門檻調低、1 檔齒比調低 |
| TCS / ABS 作用時一頓一頓 | kp 調低、ki 調低（先降 kp） |
| 靜止時車子還在微抖或慢慢滑 | V_EPS、V_RELAX_MIN 調大，Hold 頻率調高 |
| 高速太飄 | ClA 調高、maxAngle(v) 隨速度下降得更快 |

# 四、跟 Codex 合作的建議

1. **一次只貼一個 Phase**。Phase 3 和 Phase 5 最容易出錯，完成後一定要自己開，並跑 handling-report。
2. **Phase 1–4 先別調手感**，物理正確（數值合理、不抖、測試通過）之後，Phase 5 才開始調「感覺」。
3. 提出調整時，請 Codex **只改 preset JSON 的數值，不改公式**，除非確定是公式的 bug。這樣比較好追蹤，也能用 replay 比較前後差異。
4. 想更貼近 Forza，可以錄一段自己開 Forza 的影片，用同樣的動作（定圓、繞錐、手煞車甩尾）在原型裡比對：進彎延遲、滑動後恢復的速度、車身側傾量。
5. 之後換成真實車輛模型時，只換 VehicleView 的模型，物理參數則依照車重、軸距、輪距修改 preset。

---

# 五、參考實作（TypeScript）

這份程式碼是 Phase 3 與 Phase 5 的「標準答案」：

- **純邏輯**：不依賴 three.js 或 Rapier，可以直接在 Node 上測試，之後也能拿到多人伺服器上跑。
- 已通過 `tsc --strict`（含 `noUncheckedIndexedAccess`）與 **18 項 Vitest 單元測試**。
- 執行方式：`npm install`、`npm run typecheck`、`npm test`。
- 還沒有接上完整車輛（懸吊、動力系統、Rapier），那是 Codex 在 Phase 2 和 Phase 4 的工作。

## 符號約定總整理

| 量 | 正方向 |
|---|---|
| 車身 local | 前 = −Z、右 = +X、上 = +Y |
| 輪胎 v_x / v_y | 沿滾動方向前進 / 接觸點往右滑 |
| 滑動角 α | 往右滑為正；F_y 與 α 反號 |
| 滑動率 κ | 驅動打滑為正、煞車鎖死為負 |
| 輪角 δ | 向右為正 |
| yawRateRight | 車頭往右轉為正（= −ω_y） |
| 輪序 | 0 = FL、1 = FR、2 = RL、3 = RR |

## 四分之一車模擬驗證結果

單輪、車身只有縱向自由度、120 Hz、車輪子步進 4 次：

| 測試 | 結果 |
|---|---|
| 100→0 km/h 煞車，輪子鎖死 | 46.5 m |
| 100→0 km/h 煞車，ABS | **38.5 m**（目標 36–42 m） |
| 1500 N·m 起步 3 秒末速，無 TCS | 24.95 m/s（輪子空轉） |
| 1500 N·m 起步 3 秒末速，TCS | **30.83 m/s**，1 秒後最大 κ = 0.105（峰值 0.10） |
| 15% 坡道踩煞車 5 秒，無駐車錨點 | 滑 3.40 cm |
| 15% 坡道踩煞車 5 秒，有駐車錨點 | **0.39 cm** |
| 鎖死煞車 ω 跨零次數 | 0 |
| 停車側向晃動（第 2–3 秒最大 \|v_y\|），無低速橫向阻尼 | 0.011 m/s（超標） |
| 停車側向晃動，有低速橫向阻尼 | **≈ 0** |
| 隨機輸入 10,000 步 | 無 NaN |

{{CODE}}

# 六、已知限制

1. 上面的驗證都是「四分之一車」或純函式測試，**沒有包含重量轉移、懸吊與 Rapier 剛體**。整車的定圓、繞錐、甩尾手感，要等 Phase 7 的 handling-report 才能驗證。
2. 預設參數是依照一般 1350 kg 後驅轎車估算的起點，0→100、極速、煞車距離都是推算值，實車開起來仍需要調校。
3. 決定性只保證同一台機器、同一個瀏覽器。多人連線請用狀態同步，不要依賴各端重算出相同結果。
4. 方向盤力回饋在瀏覽器支援度有限，規格中列為不做。
