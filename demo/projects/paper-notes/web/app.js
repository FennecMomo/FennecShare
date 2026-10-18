// 便签纸示例：只依赖当前页面的 localStorage，没有后端。
(function () {
  var STORAGE_KEY = 'fennec-share.demo.paper-notes';
  var notes = [];

  var list = document.getElementById('notes');
  var empty = document.getElementById('empty');
  var counter = document.getElementById('counter');
  var input = document.getElementById('note');
  var composer = document.getElementById('composer');
  var reset = document.getElementById('reset');

  function load() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      notes = Array.isArray(parsed) ? parsed.filter(function (item) {
        return item && typeof item.text === 'string';
      }) : [];
    } catch (error) {
      notes = [];
    }
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch (error) {
      // 隐私模式下可能写入失败，忽略即可
    }
  }

  function render() {
    list.textContent = '';
    notes.forEach(function (note, index) {
      var item = document.createElement('li');
      if (note.done) item.className = 'done';

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(note.done);
      box.setAttribute('aria-label', '标记完成：' + note.text);
      box.addEventListener('change', function () {
        notes[index].done = box.checked;
        save();
        render();
      });

      var text = document.createElement('span');
      text.textContent = note.text;

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', '删除：' + note.text);
      remove.addEventListener('click', function () {
        notes.splice(index, 1);
        save();
        render();
      });

      item.appendChild(box);
      item.appendChild(text);
      item.appendChild(remove);
      list.appendChild(item);
    });

    empty.hidden = notes.length > 0;
    var done = notes.filter(function (note) {
      return note.done;
    }).length;
    counter.textContent = done + ' / ' + notes.length + ' 已完成';
  }

  composer.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    notes.push({ text: text, done: false });
    input.value = '';
    save();
    render();
    input.focus();
  });

  reset.addEventListener('click', function () {
    if (notes.length === 0) return;
    notes = [];
    save();
    render();
  });

  load();
  render();
})();
