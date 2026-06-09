let peer, conn, dataConn, myId;
let video;
let remoteVideo = null;
let handpose;
let mobileConnected = false;
let predictions = [];
let incomingGesture = null;
let gameState = 'COVER'; // COVER, ZAEMON, QR_WAIT, INTRO, COUNTDOWN, L1, L2, L3, FAIL, SUCCESS
let score = 0;
let levelStep = 0;
let timer = 0;
let lastActionTime = 0;
let currentQuestion = null;
let isMobile = false;
let failMsg = "";
let feeShown = false;
let successType = ""; // 1, 2, 3 for different endings
let cooldown = 0; // 防止手勢連續觸發
let levelScore = 0; // 用於計算單關分數
let pendingLevel = "L1";
let countdownNum = 3;
let lastDetectedDir = -1; // 記錄最後偵測到的方向用於視覺回饋
let zaemonTimer = 0; // 用於掛號費畫面的計時
let zaemonCallback = null;

// 顏色常數定義
const C_BLUE = [65, 105, 225]; 
const C_WHITE = [240, 248, 255]; 
const C_SKIN = [255, 224, 189]; 
const C_PATIENT = [255, 127, 80]; 

function startVideoCapture(constraints, onReady) {
  const cap = createCapture(constraints, () => {
    cap.hide();
    if (cap.elt) {
      cap.elt.muted = true;
      cap.elt.playsInline = true;
    }
    if (typeof onReady === 'function') onReady(cap);
  });
  return cap;
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  
  // PeerJS 設定，使用公開 Peer server 以便手機與電腦互連
  const peerOptions = {
    host: '0.peerjs.com',
    secure: true,
    port: 443,
    path: '/'
  };

  // 初始化 PeerJS
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('room')) {
    isMobile = true;
    const roomId = urlParams.get('room');
    peer = new Peer(undefined, peerOptions);
    peer.on('open', id => {
      video = startVideoCapture({ video: { facingMode: { ideal: 'environment' } }, audio: false }, () => {
        initHandpose();
        const stream = video.elt.srcObject || (video.elt.captureStream ? video.elt.captureStream() : null);
        if (stream) {
          const call = peer.call(roomId, stream);
          call.on('error', err => console.error('手機端呼叫錯誤：', err));
        } else {
          console.error('手機端無法取得鏡頭串流');
        }
      });

      dataConn = peer.connect(roomId);
      dataConn.on('open', () => {
        console.log('手機端資料通道已連線');
      });
      dataConn.on('error', err => console.error('資料通道錯誤：', err));
    });

    peer.on('call', call => {
      call.answer();
      call.on('stream', remoteStream => {
        if (!remoteVideo) {
          remoteVideo = createVideo('');
          remoteVideo.elt.srcObject = remoteStream;
          remoteVideo.elt.muted = true;
          remoteVideo.elt.playsInline = true;
          remoteVideo.elt.play();
          remoteVideo.hide();
        }
      });
    });
  } else {
    // 電腦端：不強制啟動本機鏡頭，只等待手機端串流
    video = null;

    peer = new Peer(undefined, peerOptions);
    peer.on('open', id => {
      myId = id;
      if (typeof updateQRCode === 'function') updateQRCode(id);
    });
    peer.on('call', call => {
      call.answer();
      call.on('stream', remoteStream => {
        if (!remoteVideo) {
          remoteVideo = createVideo('');
          remoteVideo.elt.srcObject = remoteStream;
          remoteVideo.elt.muted = true;
          remoteVideo.elt.playsInline = true;
          remoteVideo.elt.play();
          remoteVideo.hide();
          mobileConnected = true;
          console.log('已接收到手機鏡頭串流，mobileConnected =', mobileConnected);
        }
      });
    });
    peer.on('connection', conn => {
      dataConn = conn;
      dataConn.on('data', handleIncomingGesture);
      dataConn.on('error', err => console.error('主機資料通道錯誤：', err));
      dataConn.on('open', () => {
        mobileConnected = true;
        console.log('主機資料通道已連線，mobileConnected =', mobileConnected);
      });
    });
  }

  peer.on('error', err => {
    console.error('PeerJS 錯誤：', err);
  });
  peer.on('disconnected', () => {
    console.warn('PeerJS 連線已中斷，嘗試重新連線');
    if (peer && typeof peer.reconnect === 'function') {
      peer.reconnect();
    }
  });
  
  textAlign(CENTER, CENTER);
  textSize(24);
}

function handleIncomingGesture(data) {
  if (typeof data !== 'object' || data === null) return;
  if (data.type === 'gesture') {
    incomingGesture = data;
    lastDetectedDir = data.dir !== undefined ? data.dir : -1;

    if (!isMobile && millis() > cooldown) {
      if (data.dir !== undefined && data.dir !== -1) {
        processReceivedDirection(data.dir);
      }
      cooldown = millis() + 500;
    }

    if (data.isFist) {
      processReceivedFist();
    }
  }
}

function processReceivedDirection(mappedDir) {
  if (gameState === 'L1' && mappedDir === currentQuestion.dir) {
    levelScore++;
    score++;
    levelStep++;
    nextL1Question();
  } else if (gameState === 'L2' && mappedDir === currentQuestion.diffIdx) {
    levelScore += 2;
    score += 2;
    levelStep++;
    nextL2Question();
  }
}

function processReceivedFist() {
  if (gameState === 'L3') {
    let elapsed = (millis() - timer) / 1000;
    if (elapsed >= 1 && elapsed <= 3) {
      score += 0.5;
      successType = 1;
      gameState = 'SUCCESS';
    } else if (elapsed > 3 && elapsed <= 4) {
      score += 1;
      successType = 2;
      gameState = 'SUCCESS';
    } else if (elapsed >= 5 && elapsed <= 6) {
      score += 5;
      successType = 3; // 神醫匾額
      gameState = 'SUCCESS';
    }
  }
}

function sendGestureEvent(eventData) {
  if (dataConn && dataConn.open) {
    dataConn.send({ type: 'gesture', ...eventData });
  }
}

function initHandpose() {
  handpose = ml5.handpose(video, () => {
    console.log("Model Ready");
  });
  handpose.on("predict", results => {
    predictions = results;
  });
}

function draw() {
  background(C_WHITE);
  
  if (isMobile) {
    checkGestures();
    fill(C_BLUE);
    text("手機端連線中...\n請對準手部並觀察電腦畫面", width/2, height/2);
    return;
  }

  // 在角落顯示小地圖式的視訊預覽（鏡像）
  const previewVideo = remoteVideo || video;
  if (previewVideo) {
    push();
    translate(330, 10); // 調整位移以容納更大的框 (10 + 320)
    scale(-1, 1);
    image(previewVideo, -320, 0, 320, 240); // 尺寸放大一倍 (160->320, 120->240)
    noFill();
    stroke(C_BLUE);
    rect(-320, 0, 320, 240);
    pop();
    if (previewVideo === video) {
      drawHandMarkers();
    }
  }

  // 遊戲主迴圈
  switch (gameState) {
    case 'COVER': drawCoverScreen(); break;
    case 'QR_WAIT': drawQRWaitScreen(); break;
    case 'INTRO': drawIntroScreen(); break;
    case 'COUNTDOWN': drawCountdown(); break;
    case 'L1': drawLevel1(); break;
    case 'L2': drawLevel2(); break;
    case 'L3': drawLevel3(); break;
    case 'FAIL': drawFailScreen(); break;
    case 'SUCCESS': drawSuccessScreen(); break;
    case 'ZAEMON': drawZaeMonScreen(); break;
  }

  // 偵測手勢動作
  checkGestures();
}

function drawHandMarkers() {
  if (predictions.length > 0) {
    let landmarks = predictions[0].landmarks;

    // 科幻霓虹青色
    stroke(0, 255, 255, 150);
    strokeWeight(2);
    noFill();

    // 手指骨架連線定義
    const fingers = [
      [0, 1, 2, 3, 4],     // 大拇指
      [0, 5, 6, 7, 8],     // 食指
      [9, 10, 11, 12],    // 中指 (連到掌心點9)
      [13, 14, 15, 16],   // 無名指 (連到掌心點13)
      [17, 18, 19, 20],   // 小指 (連到掌心點17)
      [5, 9, 13, 17]      // 指根連線
    ];

    // 繪製骨架線條
    for (let finger of fingers) {
      beginShape();
      for (let i of finger) {
        let x = map(landmarks[i][0], 0, video.width, width, 0);
        let y = map(landmarks[i][1], 0, video.height, 0, height);
        vertex(x, y);
      }
      endShape();
    }

    // 掌心連線 (補強中指、無名指、小指到掌根的連線)
    const palmRoots = [9, 13, 17];
    let rootX = map(landmarks[0][0], 0, video.width, width, 0);
    let rootY = map(landmarks[0][1], 0, video.height, 0, height);
    for (let i of palmRoots) {
      let px = map(landmarks[i][0], 0, video.width, width, 0);
      let py = map(landmarks[i][1], 0, video.height, 0, height);
      line(rootX, rootY, px, py);
    }

    // 繪製節點 (科幻方塊效果)
    fill(0, 255, 255, 200);
    noStroke();
    for (let i = 0; i < landmarks.length; i++) {
      let x = map(landmarks[i][0], 0, video.width, width, 0);
      let y = map(landmarks[i][1], 0, video.height, 0, height);
      
      if ([4, 8, 12, 16, 20].includes(i)) {
        // 指尖加強效果：動態擴散圓圈
        push();
        fill(0, 255, 255, 50);
        let pulse = (frameCount % 20) * 2;
        circle(x, y, 10 + pulse);
        pop();
        rect(x - 4, y - 4, 8, 8); // 指尖用小方塊
      } else {
        circle(x, y, 4); // 其他關節用小點
      }
    }
    
    // 握拳判定視覺提示 (食指尖到大拇指尖)
    let tX = map(landmarks[4][0], 0, video.width, width, 0);
    let tY = map(landmarks[4][1], 0, video.height, 0, height);
    let iX = map(landmarks[8][0], 0, video.width, width, 0);
    let iY = map(landmarks[8][1], 0, video.height, 0, height);
    stroke(255, 255, 255, 100);
    drawingContext.setLineDash([5, 5]); // 虛線效果
    line(tX, tY, iX, iY);
    drawingContext.setLineDash([]); 
  }
}

function drawCoverScreen() {
  fill(C_BLUE);
  textSize(40);
  text("✨ 專業視力綜合測驗 ✨", width/2, height/2 - 50);
  textSize(22);
  text("點擊螢幕，找回你的清晰視界", width/2, height/2 + 30);
  
  // 畫個簡單裝飾
  drawHuman(width/2, height - 150, 0.8, C_PATIENT);
}

function drawQRWaitScreen() {
  fill(C_BLUE);
  textSize(24);
  text("正在偵測手機鏡頭連線...只要掃描 QR Code 即可跨網路連線", width/2, 100);
  if (mobileConnected || (remoteVideo && remoteVideo.elt && remoteVideo.elt.readyState >= 2)) {
    pendingLevel = "L1";
    gameState = "INTRO";
  }
}

function drawIntroScreen() {
  rectMode(CENTER);
  textAlign(CENTER, CENTER);
  fill(255, 255, 255, 230);
  noStroke();
  rect(width/2, height/2 - 50, width * 0.82, 240, 24);
  fill(C_BLUE);
  textSize(24);
  textLeading(32);
  let introText = "";
  if (pendingLevel === "L1") {
    introText = "【第一關：上下左右】\n\n使用手指指向 E 字的開口方向。\n共 10 題，需得 4 分以上。";
  } else if (pendingLevel === "L2") {
    introText = "【第二關：看房子】\n\n指出四個房子中「顏色不同」的那間。\n共 5 題，需得 6 分以上。";
  } else if (pendingLevel === "L3") {
    introText = "【第三關：點散瞳】\n\n當藥水呈現白色完美球時，\n迅速「握拳」滴入眼睛！";
  }
  text(introText, width/2, height/2 - 90, width * 0.72, 220);
  
  fill(C_BLUE);
  rect(width/2, height - 100, 240, 60, 14);
  fill(255);
  textSize(24);
  text("我準備好了，開始！", width/2, height - 100);
}

function drawCountdown() {
  fill(C_BLUE);
  textSize(120);
  text(countdownNum, width/2, height/2);
  if (frameCount % 60 === 0) {
    countdownNum--;
    if (countdownNum <= 0) {
      gameState = pendingLevel;
      if (gameState === 'L3') timer = millis();
      else if (gameState === 'L1') nextL1Question();
      else if (gameState === 'L2') nextL2Question();
    }
  }
}

function startLevelFlow(lvl) {
  pendingLevel = lvl;
  countdownNum = 3;
  gameState = 'INTRO';
}

function startNewGameFromScratch() {
  score = 0;
  levelScore = 0;
  levelStep = 0;
  startLevelFlow('L1');
}

function drawHuman(x, y, scaleFactor, shirtCol) {
  push();
  translate(x, y);
  scale(scaleFactor);
  noStroke();
  // 身體
  fill(shirtCol);
  rectMode(CENTER);
  rect(0, 50, 100, 80, 20);
  // 頭
  fill(C_SKIN);
  ellipse(0, -10, 60, 70);
  // 眼睛
  fill(0);
  ellipse(-15, -15, 8, 8);
  ellipse(15, -15, 8, 8);
  // 嘴巴
  stroke(0);
  noFill();
  arc(0, 5, 20, 10, 0, PI);
  pop();
}

function nextL1Question() {
  if (levelStep >= 10) {
    if (levelScore < 4) {
      failMsg = "別氣餒，你一定有機會找到自己的眼";
      gameState = 'FAIL';
    } else {
      levelStep = 0;
      levelScore = 0;
      startLevelFlow('L2');
    }
    return;
  }
  // 5組不同大小 (60, 54, 48, 42, 36)
  let sizeIdx = Math.floor(levelStep / 2);
  currentQuestion = {
    type: 'E',
    size: 60 - (sizeIdx * 6),
    dir: floor(random(4)), // 0:右(E開口), 1:下, 2:左, 3:上
    startTime: millis()
  };
}

function drawLevel1() {
  if (!video && !remoteVideo) { drawWaitingVideo(); return; }
  if (!currentQuestion) return;
  let elapsed = (millis() - currentQuestion.startTime) / 1000;
  
  fill(C_BLUE);
  textSize(20);
  text(`第一關：[上下左右] - 第 ${levelStep + 1}/10 題`, width/2, 50);
  text(`目前得分: ${levelScore} | 剩餘時間: ${max(0, (5 - elapsed).toFixed(1))}s`, width/2, 80);
  
  // 方向偵測提示
  if (lastDetectedDir !== -1) {
    push();
    fill(C_BLUE[0], C_BLUE[1], C_BLUE[2], 50);
    noStroke();
    translate(width/2, height/2);
    rotate(HALF_PI * lastDetectedDir);
    triangle(0, -100, -30, -70, 30, -70);
    pop();
  }

  push();
  translate(width/2, height/2);
  rotate(HALF_PI * currentQuestion.dir);
  stroke(C_BLUE);
  strokeWeight(currentQuestion.size / 5);
  noFill();
  // 繪製 E 字
  let s = currentQuestion.size;
  line(-s/2, -s/2, s/2, -s/2);
  line(-s/2, 0, s/2, 0);
  line(-s/2, s/2, s/2, s/2);
  line(-s/2, -s/2, -s/2, s/2);
  pop();

  if (elapsed > 5) {
    levelStep++;
    nextL1Question();
  }
}

function nextL2Question() {
  if (levelStep >= 5) {
    if (levelScore < 6) { // 5題，每題2分，未滿6分(答對少於3題)則失敗
      failMsg = "可惜，或許你上輩子是隻狗溝吧!";
      gameState = 'FAIL';
    } else {
      levelStep = 0;
      levelScore = 0;
      startLevelFlow('L3');
    }
    return;
  }
  let diffIdx = floor(random(4)); 
  let baseCol = color(random(100, 200), random(100, 200), random(100, 200));
  let diffCol = color(red(baseCol) + (random() > 0.5 ? 25 : -25), green(baseCol), blue(baseCol));
  
  currentQuestion = {
    type: 'HOUSE',
    diffIdx: diffIdx, // 0:右, 1:下, 2:左, 3:上 (與E一致)
    baseCol: baseCol,
    diffCol: diffCol,
    startTime: millis()
  };
}

function drawLevel2() {
  if (!video && !remoteVideo) { drawWaitingVideo(); return; }
  if (!currentQuestion) return;
  let elapsed = (millis() - currentQuestion.startTime) / 1000;
  
  fill(C_BLUE);
  text(`第二關：[看房子] - 第 ${levelStep + 1}/5 題`, width/2, 50);
  text(`目前得分: ${levelScore} | 剩餘時間: ${max(0, (5 - elapsed).toFixed(1))}s`, width/2, 80);

  let positions = [
    {x: 3*width/4, y: height/2},  // 0: 右
    {x: width/2, y: 3*height/4},  // 1: 下
    {x: width/4, y: height/2},    // 2: 左
    {x: width/2, y: height/4}     // 3: 上
  ];

  for (let i = 0; i < 4; i++) {
    let col = (i === currentQuestion.diffIdx) ? currentQuestion.diffCol : currentQuestion.baseCol;
    drawHouse(positions[i].x, positions[i].y, 60, col);
  }

  if (elapsed > 5) {
    levelStep++;
    nextL2Question();
  }
}

function drawHouse(x, y, size, col) {
  fill(col);
  noStroke();
  rectMode(CENTER);
  rect(x, y + size/4, size, size/2);
  triangle(x - size/2, y, x + size/2, y, x, y - size/2);
}

function drawLevel3() {
  if (!video && !remoteVideo) { drawWaitingVideo(); return; }
  let elapsed = (millis() - timer) / 1000;
  fill(C_BLUE);
  text(`第三關：[點散瞳]`, width/2, 50);
  
  // 畫病患
  drawHuman(width/2, height - 150, 1.5, C_PATIENT);
  // 放大眼睛細節
  fill(255); ellipse(width/2, height - 200, 80, 40);
  fill(0); circle(width/2, height - 200, 20);

  // 畫藥水瓶
  fill(150);
  rect(width/2, 100, 40, 80);
  
  // 藥水球邏輯
  let ballY = 150;
  if (elapsed < 1) {
    text("準備...", width/2, height/2);
  } else if (elapsed <= 3) {
    fill(0, 0, 150); // 深藍色
    circle(width/2, ballY, 20);
  } else if (elapsed <= 4) {
    fill(100, 100, 255); // 淺藍色
    circle(width/2, ballY, 40);
  } else if (elapsed < 5) {
    fill(200, 200, 255); // 準備變白色的過渡期
    circle(width/2, ballY, 50);
  } else if (elapsed >= 5 && elapsed <= 6) {
    fill(255); // 白色
    circle(width/2, ballY, 60);
  } else {
    // 自動落下
    fill(255, 100, 100); // 粉色
    let dropY = ballY + (elapsed - 6) * 500;
    circle(width/2, dropY, 60);
    if (dropY > height - 200) {
      failMsg = "功虧一簣，感覺要醫鬧了";
      gameState = 'FAIL';
    }
  }
}

function checkGestures() {
  lastDetectedDir = -1;
  if (predictions.length > 0 && millis() > cooldown) {
    let hand = predictions[0].landmarks;
    if (!hand || hand.length < 21) return;

    let wrist = hand[0];
    let indexTip = hand[8];
    let indexPIP = hand[6];
    let thumbTip = hand[4];
    let middleTip = hand[12];
    let ringTip = hand[16];
    let pinkyTip = hand[20];

    let palmCenter = [
      (hand[0][0] + hand[5][0] + hand[9][0] + hand[13][0] + hand[17][0]) / 5,
      (hand[0][1] + hand[5][1] + hand[9][1] + hand[13][1] + hand[17][1]) / 5
    ];
    let palmSize = dist(hand[5][0], hand[5][1], hand[17][0], hand[17][1]);
    let extendedThreshold = max(28, palmSize * 0.55);
    let fistThreshold = max(30, palmSize * 0.38);

    let indexExtended = dist(indexTip[0], indexTip[1], indexPIP[0], indexPIP[1]) > extendedThreshold &&
                        dist(indexTip[0], indexTip[1], palmCenter[0], palmCenter[1]) > dist(indexPIP[0], indexPIP[1], palmCenter[0], palmCenter[1]);

    let middleFolded = dist(middleTip[0], middleTip[1], palmCenter[0], palmCenter[1]) < fistThreshold;
    let ringFolded = dist(ringTip[0], ringTip[1], palmCenter[0], palmCenter[1]) < fistThreshold;
    let pinkyFolded = dist(pinkyTip[0], pinkyTip[1], palmCenter[0], palmCenter[1]) < fistThreshold;
    let thumbNearIndex = dist(thumbTip[0], thumbTip[1], indexTip[0], indexTip[1]) < palmSize * 0.45;
    let isFist = middleFolded && ringFolded && pinkyFolded && thumbNearIndex && !indexExtended;

    let mappedDir = -1;
    if (indexExtended) {
      let dx = indexTip[0] - wrist[0];
      let dy = wrist[1] - indexTip[1];
      let angle = degrees(atan2(dy, dx));
      if (angle < 0) angle += 360;
      if (angle >= 45 && angle < 135) mappedDir = 3; // 上
      else if (angle >= 135 && angle < 225) mappedDir = 2; // 左
      else if (angle >= 225 && angle < 315) mappedDir = 1; // 下
      else mappedDir = 0; // 右
    }

    lastDetectedDir = mappedDir;

    if (isMobile) {
      sendGestureEvent({ dir: mappedDir, isFist });
      cooldown = millis() + 500;
      return;
    }

    if (gameState === 'L1' && mappedDir !== -1) {
      if (mappedDir === currentQuestion.dir) {
        levelScore++;
        score++;
        levelStep++;
        cooldown = millis() + 500;
        nextL1Question();
      }
    } else if (gameState === 'L2' && mappedDir !== -1) {
      if (mappedDir === currentQuestion.diffIdx) {
        levelScore += 2;
        score += 2;
        levelStep++;
        cooldown = millis() + 500;
        nextL2Question();
      }
    } else if (gameState === 'L3' && isFist) {
      let elapsed = (millis() - timer) / 1000;
      if (elapsed >= 1 && elapsed <= 3) {
        score += 0.5;
        successType = 1;
        gameState = 'SUCCESS';
      } else if (elapsed > 3 && elapsed <= 4) {
        score += 1;
        successType = 2;
        gameState = 'SUCCESS';
      } else if (elapsed >= 5 && elapsed <= 6) {
        score += 5;
        successType = 3; // 神醫匾額
        gameState = 'SUCCESS';
      }
    }
  }
}

function drawFailScreen() {
  background(255, 230, 230); // 淺紅底
  fill(C_BLUE);
  textSize(30);
  text(failMsg, width/2, height/2 - 50);
  
  if (failMsg.includes("醫鬧")) {
    // 醫鬧動畫：病患穿綠色衣服生氣地跳來跳去
    let jumpX = width/2 + sin(frameCount * 0.2) * 100;
    let jumpY = height/2 + 120 + abs(sin(frameCount * 0.3)) * -40;
    drawHuman(jumpX, jumpY, 1.2, [34, 139, 34]); 
    textSize(40);
    text("💢", jumpX + 40, jumpY - 60);
  }

  drawRestartBtn();
}

function drawSuccessScreen() {
  background(230, 255, 230); // 淺綠底
  fill(C_BLUE);
  let title = "";
  if (successType === 1) {
    title = "獲得稱號：【一雙慧眼】";
    drawHuman(width/2, height/2 + 100, 1.0, C_PATIENT);
    text("👍", width/2 + 40, height/2 + 80); 
  } else if (successType === 2) {
    title = "獲得稱號：【卡茲蘭大眼睛】";
    text("📸 謝謝醫生！(合照中)", width/2, height/2 + 100);
  } else if (successType === 3) {
    title = "獲得：【神醫匾額】";
    fill(255, 215, 0);
    rect(width/2, height/2 + 80, 300, 100);
    fill(0);
    textSize(24);
    text("妙手回春", width/2, height/2 + 80);
  }
  
  fill(C_BLUE);
  textSize(35);
  text(title, width/2, height/2 - 50);
  drawRestartBtn();
}

function drawRestartBtn() {
  rectMode(CENTER);
  textAlign(CENTER, CENTER);
  fill(C_BLUE);
  rect(width/2, height - 100, 200, 50, 10);
  fill(255);
  textSize(22);
  text("重新挑戰", width/2, height - 100);
}

function drawWaitingVideo() {
  fill(C_BLUE);
  text("偵測不到鏡頭連線，請確認手機已掃碼且電腦/手機可連上網路。", width/2, height/2);
}

function mousePressed() {
  if (gameState === 'COVER') {
    showZaeMonMessage(() => {
      gameState = 'QR_WAIT';
    });
  } else if (gameState === 'INTRO') {
    // 點擊「準備好了」
    if (mouseX > width/2 - 100 && mouseX < width/2 + 100 && mouseY > height - 125 && mouseY < height - 75) {
      gameState = 'COUNTDOWN';
      countdownNum = 3;
    }
  } else if (gameState === 'FAIL' || gameState === 'SUCCESS') {
    if (mouseX > width/2 - 100 && mouseX < width/2 + 100 && mouseY > height - 125 && mouseY < height - 75) {
      showZaeMonMessage(() => {
        startNewGameFromScratch();
      });
    }
  }
}

function showZaeMonMessage(callback) {
  gameState = 'ZAEMON';
  zaemonTimer = millis();
  zaemonCallback = callback;
}

function drawZaeMonScreen() {
  background(255, 230, 240);
  fill(C_BLUE);
  textSize(28);
  text("肥嘟嘟佐衛門：", width/2, height/2 - 40);
  text("好的跟您收掛號費 100 萬元", width/2, height/2 + 10);

  fill(255, 150, 150);
  ellipse(width/2, height/2 + 120, 100, 80);
  fill(0);
  circle(width/2 - 20, height/2 + 110, 10);
  circle(width/2 + 20, height/2 + 110, 10);

  if (millis() - zaemonTimer > 2000) {
    if (zaemonCallback) {
      let next = zaemonCallback;
      zaemonCallback = null;
      next();
    }
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}