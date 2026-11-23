# 閱讀筆記：Softmax

Softmax 將一組分數轉成機率。每一項都大於零，總和是 $1$。

## 定義

$$
p_i = \frac{\exp(z_i)}{\sum_{j=1}^{n}\exp(z_j)}
$$

| 符號 | 說明 |
| --- | --- |
| $z_i$ | 第 $i$ 類的原始分數 |
| $p_i$ | 第 $i$ 類的機率 |
| $n$ | 類別數 |

> 實作時可先減去最大分數，避免指數運算溢位。

```python
shifted = scores - scores.max()
weights = np.exp(shifted)
probabilities = weights / weights.sum()
```
