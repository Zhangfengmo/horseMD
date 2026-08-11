# Table save reproduction fixture

before-table-sentinel

```c
#include <stdio.h>

int main(void) {
  puts("table fixture");
  return 0;
}
```

```python
labels = ['source', 'rich', 'save']
print(', '.join(labels))
```

| one | two | three | four | five |
| - | -- | --- | :---: | ---: |
| authored short |
| second short |
| editable full | b | c | d | e |
| complete | w | x | y | z |

after-table-sentinel
