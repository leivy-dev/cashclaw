def fibonacci(n: int) -> list[int]:
    """
    Calculate the Fibonacci sequence up to n terms.

    Args:
        n: The number of terms to generate. Must be a non-negative integer.

    Returns:
        A list containing the first n Fibonacci numbers.

    Examples:
        >>> fibonacci(0)
        []
        >>> fibonacci(1)
        [0]
        >>> fibonacci(5)
        [0, 1, 1, 2, 3]
        >>> fibonacci(8)
        [0, 1, 1, 2, 3, 5, 8, 13]
    """
    if n <= 0:
        return []
    if n == 1:
        return [0]

    sequence = [0, 1]
    for _ in range(2, n):
        sequence.append(sequence[-1] + sequence[-2])

    return sequence


# Example usage
if __name__ == "__main__":
    for count in [0, 1, 5, 8, 10]:
        print(f"fibonacci({count}) = {fibonacci(count)}")
