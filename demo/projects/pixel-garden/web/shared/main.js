// 像素花园：点击方格切换状态（空 → 幼苗 → 开花）。
(function () {
  var garden = document.getElementById('garden');
  var status = document.getElementById('status');
  var TOTAL = 48;

  var tiles = [];

  function label() {
    var bloomed = tiles.filter(function (tile) {
      return Number(tile.dataset.bloom) === 2;
    }).length;
    var planted = tiles.filter(function (tile) {
      return Number(tile.dataset.bloom) > 0;
    }).length;
    status.textContent =
      planted === 0
        ? '还没有种下任何像素。'
        : '已种下 ' + planted + ' 格，其中 ' + bloomed + ' 格开花。';
  }

  for (var index = 0; index < TOTAL; index += 1) {
    var tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset.bloom = '0';
    tile.setAttribute('aria-label', '第 ' + (index + 1) + ' 格');
    tile.addEventListener('click', function () {
      var current = Number(this.dataset.bloom);
      var next = (current + 1) % 3;
      this.dataset.bloom = String(next);
      label();
    });
    garden.appendChild(tile);
    tiles.push(tile);
  }

  label();
})();
