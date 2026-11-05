/* Isolation Forest (Liu, Ting, Zhou 2008) — 외부 라이브러리 없는 순수 JS 구현
 *
 * 아이디어: 이상한 점은 "드물고 다르다" → 무작위로 축과 분할값을 골라 계속 자르면
 * 이상한 점은 몇 번 만에 혼자 남고(경로가 짧음), 정상 점은 여러 번 잘라야 혼자 남는다(경로가 김).
 *
 *   점수 s(x) = 2^( -E[h(x)] / c(ψ) )     h = 나무에서 혼자 남을 때까지 내려간 깊이
 *                                         c(ψ) = 표본 ψ개 이진 탐색 나무의 평균 경로 길이 (정규화용)
 *   s ≈ 1 → 이상,  s ≈ 0.5 이하 → 정상
 *
 * 보완: 범위 검사 (SCiForest, Liu 2010)
 *   표준 방식은 학습 표본 범위 밖의 값(예: 평소 40 W 인 장비의 0 W)도 가장자리 정상 점과 같은 길로 내려가
 *   점수가 충분히 높아지지 않는다. 각 마디에 학습 표본의 값 범위를 저장하고,
 *   새 값이 그 범위를 벗어나면 그 마디에서 바로 고립된 것으로 본다. rangeCheck:false 로 끌 수 있다.
 *
 * 브라우저(window.IForest)와 node(require) 양쪽에서 쓸 수 있다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IForest = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const EULER = 0.5772156649;

  // c(n): n개 점으로 만든 이진 탐색 나무에서 실패 검색의 평균 경로 길이
  function cFactor(n) {
    if (n > 2) return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
    return n === 2 ? 1 : 0;
  }

  // 재현 가능한 난수 (같은 seed → 같은 숲)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildTree(X, idx, depth, limit, rand) {
    if (depth >= limit || idx.length <= 1) return { size: idx.length };
    const dims = X[0].length;
    // 값이 모두 같은 축은 자를 수 없으므로 다른 축을 시도
    const order = Array.from({ length: dims }, (_, i) => i);
    for (let i = dims - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const q of order) {
      let min = Infinity, max = -Infinity;
      for (const i of idx) { const v = X[i][q]; if (v < min) min = v; if (v > max) max = v; }
      if (max <= min) continue;
      const p = min + rand() * (max - min);
      const L = [], R = [];
      for (const i of idx) (X[i][q] < p ? L : R).push(i);
      return { q, p, min, max, left: buildTree(X, L, depth + 1, limit, rand), right: buildTree(X, R, depth + 1, limit, rand) };
    }
    return { size: idx.length };
  }

  function pathLength(x, node, rangeCheck, tol) {
    let depth = 0;
    while (node.q !== undefined) {
      const v = x[node.q];
      if (rangeCheck) {                                   // 학습 범위(+여유) 밖 → 여기서 고립
        const pad = tol * (node.max - node.min);
        if (v < node.min - pad || v > node.max + pad) return depth + 1;
      }
      node = v < node.p ? node.left : node.right;
      depth++;
    }
    return depth + cFactor(node.size);
  }

  /**
   * @param {number[][]} X  학습 데이터 (행 = 시점, 열 = 특징값)
   * @param {{nTrees?:number, sampleSize?:number, seed?:number, rangeCheck?:boolean}} opt
   */
  function fit(X, opt = {}) {
    const nTrees = opt.nTrees ?? 200;
    const psi = Math.min(opt.sampleSize ?? 256, X.length);
    const rangeCheck = opt.rangeCheck ?? true;
    const tol = opt.tolerance ?? 1;            // 범위 폭의 몇 배까지 벗어나도 봐줄지 (깊은 마디는 범위가 좁아 정상 점도 살짝 벗어나기 때문)
    const rand = mulberry32(opt.seed ?? 42);
    const limit = Math.ceil(Math.log2(Math.max(psi, 2)));    // 평균 깊이 이상은 더 자르지 않음 (원 논문)
    const trees = [];
    const pool = Array.from({ length: X.length }, (_, i) => i);
    for (let t = 0; t < nTrees; t++) {
      // 비복원 표본 ψ개 (부분 Fisher-Yates, 배열을 재사용해도 매번 균등한 무작위 표본)
      for (let i = 0; i < psi; i++) { const j = i + Math.floor(rand() * (X.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      trees.push(buildTree(X, pool.slice(0, psi), 0, limit, rand));
    }
    const c = cFactor(psi);
    return {
      nTrees, sampleSize: psi, rangeCheck, tolerance: tol,
      /** 이상 점수 0~1 (높을수록 이상) */
      score(x) {
        let sum = 0;
        for (const tr of trees) sum += pathLength(x, tr, rangeCheck, tol);
        return Math.pow(2, -(sum / trees.length) / c);
      }
    };
  }

  return { fit, cFactor, mulberry32 };
});
