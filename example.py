def for_loop_example(items):
    """
    遍历列表中的每个元素并打印。
    """
    results = []
    for item in items:
        print(item)
        results.append(item)
    return results


# 使用示例
if __name__ == "__main__":
    fruits = ["苹果", "香蕉", "橙子", "葡萄"]
    result = for_loop_example(fruits)
    print(f"\n返回结果: {result}")
